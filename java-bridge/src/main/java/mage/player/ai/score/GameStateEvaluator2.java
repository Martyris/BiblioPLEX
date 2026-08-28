package mage.player.ai.score;

import mage.game.Game;
import mage.game.permanent.Permanent;
import mage.players.Player;
import org.apache.log4j.Logger;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import mage.abilities.Ability;
import mage.abilities.effects.Effect;
import mage.constants.Outcome;

/**
 * @author nantuko
 * <p>
 * BiblioPLEX FORK: the upstream version of this class (see its own comment, still true upstream:
 * "This evaluator is only good for two player games") picks exactly ONE opponent via
 * `game.getOpponents(playerId, false).stream().findFirst()` and scores against only that one,
 * discarding the rest of a multiplayer pod entirely from the AI's own board evaluation — this is
 * the root cause of the AI's poor judgement in >2 player games (a 4-player Commander pod is
 * BiblioPLEX's whole use case), not a fixable-via-config emergent quirk. This class is `final`
 * with only `static` methods (confirmed via the upstream source), so there's no way to override
 * its behavior by subclassing `ComputerPlayer6`/`ComputerPlayer7` — every call site
 * (`ComputerPlayer6` calls `GameStateEvaluator2.evaluate(...).getTotalScore()` directly, dozens
 * of times, for every node the minimax search visits) goes straight through this static method.
 * The only way to change what it does is to ship a same-package, same-name replacement that
 * shadows the upstream class in the assembled jar (maven-assembly-plugin's jar-with-dependencies
 * puts this project's own compiled classes in AFTER extracting dependency jars, so this file
 * wins) — this file is exactly that: a full copy of the upstream class with `evaluate()`
 * reworked to aggregate ALL opponents instead of just one, everything else left as-is.
 */
public final class GameStateEvaluator2 {

    private static final Logger logger = Logger.getLogger(GameStateEvaluator2.class);

    public static final int WIN_GAME_SCORE = 100000000;
    public static final int LOSE_GAME_SCORE = -WIN_GAME_SCORE;

    public static final int HAND_CARD_SCORE = 5;

    public static PlayerEvaluateScore evaluate(UUID playerId, Game game) {
        return evaluate(playerId, game, true);
    }

    public static PlayerEvaluateScore evaluate(UUID playerId, Game game, boolean useCombatPermanentScore) {
        Player player = game.getPlayer(playerId);

        // Every opponent still in the game, not just the first one found — see the class
        // comment. An opponent who has already left/lost is excluded the same way the upstream
        // findFirst() implicitly would have skipped a departed player.
        List<Player> opponents = new ArrayList<>();
        for (UUID opponentId : game.getOpponents(playerId, false)) {
            Player opponent = game.getPlayer(opponentId);
            if (opponent != null) {
                opponents.add(opponent);
            }
        }
        if (opponents.isEmpty()) {
            return new PlayerEvaluateScore(playerId, WIN_GAME_SCORE);
        }

        if (game.checkIfGameIsOver()) {
            if (player.hasLost()) {
                return new PlayerEvaluateScore(playerId, LOSE_GAME_SCORE);
            }
            boolean allOpponentsGone = true;
            for (Player opponent : opponents) {
                if (!opponent.hasLost()) {
                    allOpponentsGone = false;
                    break;
                }
            }
            if (player.hasWon() || allOpponentsGone) {
                return new PlayerEvaluateScore(playerId, WIN_GAME_SCORE);
            }
        }

        int playerLifeScore;
        int opponentLifeScore = 0;
        if (player.getLife() <= 0) { // we don't want a tie
            playerLifeScore = ArtificialScoringSystem.LOSE_GAME_SCORE;
        } else {
            playerLifeScore = ArtificialScoringSystem.getLifeScore(player.getLife());
            // A single opponent already at/below 0 life isn't a global win in a pod of 4 — just
            // zero threat from that specific opponent (they contribute nothing further), rather
            // than the upstream single-opponent branch's WIN_GAME_SCORE short-circuit.
            for (Player opponent : opponents) {
                if (opponent.getLife() > 0) {
                    opponentLifeScore += ArtificialScoringSystem.getLifeScore(opponent.getLife());
                }
            }
        }

        int playerPermanentsScore = 0;
        int opponentPermanentsScore = 0;
        try {
            StringBuilder sbPlayer = new StringBuilder();
            StringBuilder sbOpponent = new StringBuilder();

            // add values of player
            for (Permanent permanent : game.getBattlefield().getAllActivePermanents(playerId)) {
                int onePermScore = evaluatePermanent(permanent, game, useCombatPermanentScore);
                playerPermanentsScore += onePermScore;
                if (logger.isDebugEnabled()) {
                    sbPlayer.append(permanent.getName()).append('[').append(onePermScore).append("] ");
                }
            }
            if (logger.isDebugEnabled()) {
                sbPlayer.insert(0, playerPermanentsScore + " - ");
                sbPlayer.insert(0, "Player..: ");
                logger.debug(sbPlayer);
            }

            // add values of every opponent combined
            for (Player opponent : opponents) {
                for (Permanent permanent : game.getBattlefield().getAllActivePermanents(opponent.getId())) {
                    int onePermScore = evaluatePermanent(permanent, game, useCombatPermanentScore);
                    opponentPermanentsScore += onePermScore;
                    if (logger.isDebugEnabled()) {
                        sbOpponent.append(permanent.getName()).append('[').append(onePermScore).append("] ");
                    }
                }
            }
            if (logger.isDebugEnabled()) {
                sbOpponent.insert(0, opponentPermanentsScore + " - ");
                sbOpponent.insert(0, "Opponents: ");
                logger.debug(sbOpponent);
            }
        } catch (Throwable t) {
        }

        int playerHandScore = player.getHand().size() * HAND_CARD_SCORE;
        int opponentHandScore = 0;
        for (Player opponent : opponents) {
            opponentHandScore += opponent.getHand().size() * HAND_CARD_SCORE;
        }

        int score = (playerLifeScore - opponentLifeScore)
                + (playerPermanentsScore - opponentPermanentsScore)
                + (playerHandScore - opponentHandScore);
        logger.debug(score
                + " total Score (life:" + (playerLifeScore - opponentLifeScore)
                + " permanents:" + (playerPermanentsScore - opponentPermanentsScore)
                + " hand:" + (playerHandScore - opponentHandScore) + ')');
        return new PlayerEvaluateScore(
                playerId,
                playerLifeScore, playerHandScore, playerPermanentsScore,
                opponentLifeScore, opponentHandScore, opponentPermanentsScore);
    }

    public static int evaluatePermanent(Permanent permanent, Game game, boolean useCombatPermanentScore) {
        // prevent AI from attaching bad auras to its own permanents ex: Brainwash and Demonic Torment (no immediate penalty on the battlefield)
        int value = 0;
        if (!permanent.getAttachments().isEmpty()) {
            for (UUID attachmentId : permanent.getAttachments()) {
                Permanent attachment = game.getPermanent(attachmentId);
                for (Ability a : attachment.getAbilities(game)) {
                    for (Effect e : a.getEffects()) {
                        if (e.getOutcome().equals(Outcome.Detriment)
                                && attachment.getControllerId().equals(permanent.getControllerId())) {
                            value -= 1000;  // seems to work well ; -300 is not effective enough
                        }
                    }
                }
            }
        }
        value += ArtificialScoringSystem.getFixedPermanentScore(game, permanent);
        value += ArtificialScoringSystem.getDynamicPermanentScore(game, permanent);
        if (useCombatPermanentScore) {
            value += ArtificialScoringSystem.getCombatPermanentScore(game, permanent);
        }
        return value;
    }

    public static class PlayerEvaluateScore {

        private UUID playerId;
        private int playerLifeScore = 0;
        private int playerHandScore = 0;
        private int playerPermanentsScore = 0;

        private int opponentLifeScore = 0;
        private int opponentHandScore = 0;
        private int opponentPermanentsScore = 0;

        private int specialScore = 0; // special score (ignore all others, e.g. for win/lose game states)

        public PlayerEvaluateScore(UUID playerId, int specialScore) {
            this.playerId = playerId;
            this.specialScore = specialScore;
        }

        public PlayerEvaluateScore(UUID playerId,
                                   int playerLifeScore, int playerHandScore, int playerPermanentsScore,
                                   int opponentLifeScore, int opponentHandScore, int opponentPermanentsScore) {
            this.playerId = playerId;
            this.playerLifeScore = playerLifeScore;
            this.playerHandScore = playerHandScore;
            this.playerPermanentsScore = playerPermanentsScore;
            this.opponentLifeScore = opponentLifeScore;
            this.opponentHandScore = opponentHandScore;
            this.opponentPermanentsScore = opponentPermanentsScore;
        }

        public UUID getPlayerId() {
            return this.playerId;
        }

        public int getPlayerScore() {
            return playerLifeScore + playerHandScore + playerPermanentsScore;
        }

        public int getOpponentScore() {
            return opponentLifeScore + opponentHandScore + opponentPermanentsScore;
        }

        public int getTotalScore() {
            if (specialScore != 0) {
                return specialScore;
            } else {
                return getPlayerScore() - getOpponentScore();
            }
        }

        public int getPlayerLifeScore() {
            return playerLifeScore;
        }

        public int getPlayerHandScore() {
            return playerHandScore;
        }

        public int getPlayerPermanentsScore() {
            return playerPermanentsScore;
        }

        public String getPlayerInfoFull() {
            return "Life:" + playerLifeScore
                    + ", Hand:" + playerHandScore
                    + ", Perm:" + playerPermanentsScore;
        }

        public String getPlayerInfoShort() {
            return "L:" + playerLifeScore
                    + ",H:" + playerHandScore
                    + ",P:" + playerPermanentsScore;
        }

        public String getOpponentInfoFull() {
            return "Life:" + opponentLifeScore
                    + ", Hand:" + opponentHandScore
                    + ", Perm:" + opponentPermanentsScore;
        }

        public String getOpponentInfoShort() {
            return "L:" + opponentLifeScore
                    + ",H:" + opponentHandScore
                    + ",P:" + opponentPermanentsScore;
        }
    }
}
