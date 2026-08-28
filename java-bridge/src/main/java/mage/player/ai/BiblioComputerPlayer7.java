package mage.player.ai;

import mage.abilities.Ability;
import mage.abilities.ActivatedAbility;
import mage.abilities.SpellAbility;
import mage.abilities.keyword.FlashAbility;
import mage.cards.Card;
import mage.constants.CardType;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.permanent.Permanent;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * BiblioPLEX fork of ComputerPlayer7 — see the research this was built from: upstream's
 * priorityPlay() (a private method in ComputerPlayer7, so it can't be reused via a targeted
 * override — this is a full copy with one change) unconditionally auto-passes priority during
 * BEGIN_COMBAT, FIRST_COMBAT_DAMAGE, COMBAT_DAMAGE, and END_COMBAT, WITHOUT EVER calling
 * calculateActions() there — meaning the AI structurally never considers casting an instant
 * during those steps, no matter what's in hand or how much mana is open. Concretely, this is why
 * a card like Fire Lord Azula ("whenever you cast a spell while Fire Lord Azula is attacking,
 * copy that spell") almost never triggers from AI play, and why the AI never holds up mana to
 * respond to something on an opponent's combat.
 *
 * This subclass reuses ComputerPlayer6's real minimax search (calculateActions/act, both
 * `protected`) during those same steps too — but only when hasUsefulInstantSpeedOption(game)
 * finds something actually castable right now, via Player.getPlayable(game, true) (the same
 * timing-aware legality check used to build read player UI, correctly excludes sorcery-speed
 * cards outside a main phase on its own). Gating on that avoids running the (expensive, up to
 * 30s-capped) search on every single combat step of every turn when there's nothing to consider
 * anyway — tapped out, empty hand, everything sorcery-speed — which is the overwhelmingly common
 * case and would otherwise be a pure performance cost for zero behavioral gain.
 */
public class BiblioComputerPlayer7 extends ComputerPlayer7 {

    // Deck-specific — which permanent names (if any) should make this player hold instants/flash
    // spells back until they're actually attacking, so an attack-triggered-on-cast ability
    // (Fire Lord Azula, etc.) fires instead of the card being spent early for its plain value.
    // Populated from this seat's Logic file (see docs/logic-file-guide.md and Main.java, which
    // parses "holdInstantUntilAttackTrigger" rules into this set) — empty for a deck with no
    // Logic file attached, which is behaviorally identical to not holding anything.
    private final Set<String> holdInstantsWhileNotAttacking;

    public BiblioComputerPlayer7(String name, RangeOfInfluence range, int skill, Set<String> holdInstantsWhileNotAttacking) {
        super(name, range, skill);
        this.holdInstantsWhileNotAttacking = holdInstantsWhileNotAttacking;
    }

    public BiblioComputerPlayer7(final BiblioComputerPlayer7 player) {
        super(player);
        this.holdInstantsWhileNotAttacking = player.holdInstantsWhileNotAttacking;
    }

    @Override
    public BiblioComputerPlayer7 copy() {
        return new BiblioComputerPlayer7(this);
    }

    @Override
    public boolean priority(Game game) {
        game.resumeTimer(getTurnControlledBy());
        boolean result = priorityPlay(game);
        game.pauseTimer(getTurnControlledBy());
        return result;
    }

    private boolean priorityPlay(Game game) {
        game.getState().setPriorityPlayerId(playerId);
        game.firePriorityEvent(playerId);
        switch (game.getTurnStepType()) {
            case UPKEEP:
            case DRAW:
                pass(game);
                return false;
            case PRECOMBAT_MAIN:
                printBattlefieldScore(game, "Sim PRIORITY on MAIN 1");
                if (actions.isEmpty()) {
                    calculateActionsWithDebug(game);
                } else {
                    throw new IllegalStateException("wtf");
                }
                act(game);
                return true;
            case BEGIN_COMBAT:
                if (hasUsefulInstantSpeedOption(game)) {
                    printBattlefieldScore(game, "Sim PRIORITY on BEGIN COMBAT (instant-speed option found)");
                    if (actions.isEmpty()) {
                        calculateActionsWithDebug(game);
                    } else {
                        throw new IllegalStateException("wtf");
                    }
                    act(game);
                    return true;
                }
                pass(game);
                return false;
            case DECLARE_ATTACKERS:
                printBattlefieldScore(game, "Sim PRIORITY on DECLARE ATTACKERS");
                if (actions.isEmpty()) {
                    calculateActionsWithDebug(game);
                } else {
                    throw new IllegalStateException("wtf");
                }
                act(game);
                return true;
            case DECLARE_BLOCKERS:
                printBattlefieldScore(game, "Sim PRIORITY on DECLARE BLOCKERS");
                if (actions.isEmpty()) {
                    calculateActionsWithDebug(game);
                } else {
                    throw new IllegalStateException("wtf");
                }
                act(game);
                return true;
            case FIRST_COMBAT_DAMAGE:
            case COMBAT_DAMAGE:
            case END_COMBAT:
                // The exact window a "while attacking" trigger (Fire Lord Azula, etc.) needs the
                // AI to actually consider casting something in — see the class comment.
                if (hasUsefulInstantSpeedOption(game)) {
                    printBattlefieldScore(game, "Sim PRIORITY on " + game.getTurnStepType() + " (instant-speed option found)");
                    if (actions.isEmpty()) {
                        calculateActionsWithDebug(game);
                    } else {
                        throw new IllegalStateException("wtf");
                    }
                    act(game);
                    return true;
                }
                pass(game);
                return false;
            case POSTCOMBAT_MAIN:
                printBattlefieldScore(game, "Sim PRIORITY on MAIN 2");
                if (actions.isEmpty()) {
                    calculateActionsWithDebug(game);
                } else {
                    throw new IllegalStateException("wtf");
                }
                act(game);
                return true;
            case END_TURN:
            case CLEANUP:
                actionCache.clear();
                pass(game);
                return false;
        }
        return false;
    }

    /**
     * Cheap pre-check so the expensive search only runs when there's actually something to
     * weigh — getPlayable(game, true) is the same call real player UI uses to know what's
     * legally castable/activatable right now, so it already respects instant-vs-sorcery timing,
     * available mana, and every other legality rule without this needing to duplicate any of
     * that logic itself.
     */
    private boolean hasUsefulInstantSpeedOption(Game game) {
        List<ActivatedAbility> playable = getPlayable(game, true);
        return playable != null && !playable.isEmpty();
    }

    /**
     * ComputerPlayer6.optimize() (protected, called right before every search) prunes/reorders
     * the candidate action list — this adds one more pass on top of the 5 upstream built-ins
     * (still run first via super.optimize()): if this player controls a permanent named in
     * holdInstantsWhileNotAttacking (from this seat's Logic file) that isn't attacking yet but
     * still could be this turn, and it's still early enough in the turn for that to matter,
     * remove "cast an instant/flash
     * spell from hand" from the candidates entirely for this search call — forcing the search to
     * either do something else or pass, rather than spending the card now for its plain value
     * when waiting until the attack step (a window this fork's priorityPlay now actually
     * searches — see hasUsefulInstantSpeedOption) would trigger the bonus instead. Removing an
     * action here doesn't lose the card: the same instant simply becomes a candidate again at
     * the NEXT priority window's own (separate) search call — worst case it's held one step
     * longer than upstream, not indefinitely.
     */
    @Override
    protected void optimize(Game game, List<Ability> allActions) {
        super.optimize(game, allActions);
        if (!isEarlyEnoughToStillWaitForAttack(game)) {
            return;
        }
        if (!controlsAnEligibleHoldTrigger(game)) {
            return;
        }
        allActions.removeIf(ability -> isCastingHeldInstant(game, ability));
    }

    private boolean isEarlyEnoughToStillWaitForAttack(Game game) {
        switch (game.getTurnStepType()) {
            case UPKEEP:
            case DRAW:
            case PRECOMBAT_MAIN:
            case BEGIN_COMBAT:
                return true;
            default:
                // Combat's already happened (or is happening) this turn — the window this would
                // have been holding for is either here now (priorityPlay's own combat-step
                // search already covers that) or gone, so there's nothing left to gain by
                // continuing to hold.
                return false;
        }
    }

    private boolean controlsAnEligibleHoldTrigger(Game game) {
        if (holdInstantsWhileNotAttacking.isEmpty()) {
            return false;
        }
        for (Permanent permanent : game.getBattlefield().getAllActivePermanents(playerId)) {
            if (!holdInstantsWhileNotAttacking.contains(permanent.getName())) {
                continue;
            }
            if (permanent.isAttacking()) {
                continue; // already benefiting right now — nothing to hold for anymore
            }
            if (permanent.isTapped() || permanent.hasSummoningSickness()) {
                continue; // can't attack this turn at all — holding would be pure downside
            }
            return true;
        }
        return false;
    }

    private boolean isCastingHeldInstant(Game game, Ability ability) {
        // No zone restriction here — a Flashback cast from the graveyard (Zone.GRAVEYARD) is
        // just as much "an instant/flash spell being cast" as one from hand, and just as worth
        // holding for the attack window. Real-game data showed exactly this gap: Laughing Mad
        // (Instant, Flashback {3}{R}) got cast from the graveyard during Precombat Main, never
        // considered by the hold filter at all because the old check required Zone.HAND.
        if (!(ability instanceof SpellAbility)) {
            return false;
        }
        Card card = game.getCard(ability.getSourceId());
        if (card == null) {
            return false;
        }
        return card.getCardType(game).contains(CardType.INSTANT) || card.getAbilities(game).containsClass(FlashAbility.class);
    }

    /**
     * Complement to optimize()'s hold logic above: the whole point of holding was to cast
     * something into the attack-trigger once it's actually attacking — but real games (see the
     * debug-decisions.log trace from the "why didn't she cast Focus the Mind" investigation)
     * showed the search's own plan can still come back empty (pass) even though a legal, eligible
     * instant was sitting right there castable. XMage's minimax lookahead has known gaps around
     * simulating triggered/copy effects (the copy is exactly what makes casting worth it here),
     * so its own evaluation likely can't see the payoff and rates "pass" as fine. Rather than
     * trying to fix that simulation gap generically, this forces the specific, narrow case we
     * already know matters: if the search's plan is empty while a hold-trigger creature is
     * actively attacking and something eligible is legally castable, queue the biggest one
     * (highest mana value, as a simple stand-in for "most worth doubling") directly — same
     * queuing act() would consume for a normal search result, just skipping trusting the
     * evaluation for this one decision.
     */
    private void forceCastIntoAttackTriggerIfPassing(Game game) {
        if (!actions.isEmpty() || !hasActivelyAttackingHoldTrigger(game)) {
            return;
        }
        List<ActivatedAbility> playable = getPlayable(game, true);
        if (playable == null) {
            return;
        }
        ActivatedAbility best = null;
        int bestManaValue = -1;
        for (ActivatedAbility ability : playable) {
            if (!isCastingHeldInstant(game, ability)) {
                continue;
            }
            Card card = game.getCard(ability.getSourceId());
            int manaValue = card != null ? card.getManaValue() : 0;
            if (manaValue > bestManaValue) {
                bestManaValue = manaValue;
                best = ability;
            }
        }
        if (best != null) {
            actions.add(best);
        }
    }

    private boolean hasActivelyAttackingHoldTrigger(Game game) {
        if (holdInstantsWhileNotAttacking.isEmpty()) {
            return false;
        }
        for (Permanent permanent : game.getBattlefield().getAllActivePermanents(playerId)) {
            if (holdInstantsWhileNotAttacking.contains(permanent.getName()) && permanent.isAttacking()) {
                return true;
            }
        }
        return false;
    }

    // --- TEMPORARY debug instrumentation (AI sequencing investigation) ---
    // Unconditionally logs every search decision, for every player (this fork is used for all 4
    // seats — see Main.java), comparing what was legally castable right now (getPlayable)
    // against what the search actually queued to execute (actions). A single specific card in a
    // 99-card singleton deck won't reliably recur across random games, so this doesn't gate on
    // any one card/scenario — it's a full per-decision trace of an entire game, greppable
    // afterward for whatever question actually comes up (a card name, a player's seat, a turn
    // number). gameSim.ts swallows java-bridge's stderr, so this writes to its own file instead.
    // Remove once the investigation concludes — same technique used earlier for the Azula
    // combat-search question.
    private void calculateActionsWithDebug(Game game) {
        calculateActions(game);
        forceCastIntoAttackTriggerIfPassing(game);
        debugLogDecision(game);
    }

    private void debugLogDecision(Game game) {
        try (PrintWriter out = new PrintWriter(new FileWriter("debug-decisions.log", true))) {
            out.println("=== turn " + game.getTurnNum() + " " + game.getTurnStepType() + " | " + getName() + " ===");
            out.println("hand: " + getHand().getCards(game).stream().map(Card::getName).collect(Collectors.joining(", ")));
            out.println("playable: " + getPlayable(game, true).stream().map(a -> describeAbility(game, a)).collect(Collectors.joining(" | ")));
            out.println("queued:   " + actions.stream().map(a -> describeAbility(game, a)).collect(Collectors.joining(" | ")));
            out.println();
        } catch (Exception e) {
            // Best-effort debug logging only — never let a logging failure break the game.
        }
    }

    private String describeAbility(Game game, Ability ability) {
        Card card = game.getCard(ability.getSourceId());
        return (card != null ? card.getName() : String.valueOf(ability.getSourceId())) + " [" + ability.getRule() + "]";
    }
}
