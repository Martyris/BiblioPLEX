package com.biblioplex.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import mage.cards.Card;
import mage.cards.decks.Deck;
import mage.cards.decks.DeckCardLists;
import mage.cards.decks.importer.DeckImporter;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;
import mage.cards.repository.CardScanner;
import mage.constants.CardType;
import mage.constants.CommanderCardType;
import mage.constants.MultiplayerAttackOption;
import mage.constants.RangeOfInfluence;
import mage.game.CommanderFreeForAllMatch;
import mage.game.Game;
import mage.game.GameOptions;
import mage.game.events.TableEvent;
import mage.game.match.MatchOptions;
import mage.game.mulligan.MulliganType;
import mage.game.permanent.Permanent;
import mage.game.stack.StackObject;
import mage.player.ai.BiblioComputerPlayer7;
import mage.players.Player;
import mage.watchers.common.CommanderInfoWatcher;
import mage.watchers.common.CommanderPlaysCountWatcher;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileWriter;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Long-lived headless XMage bridge process — started once by BiblioPLEX's Electron main
 * process and kept warm for the whole session, since CardScanner.scan() alone costs ~60-70s
 * per JVM cold-start (confirmed during the Part 0 spike) and paying that per game/request would
 * make even a single "Watch Game" click feel broken.
 *
 * Protocol: one JSON object per line on stdin, one JSON object per line on stdout, matched by
 * "id". Never prints anything else to stdout (XMage's own logging goes through log4j to
 * stderr/console — see log4j.properties — so stdout stays clean for the protocol).
 *
 * Request shapes:
 *   {"id":"1","type":"checkCards","cardNames":["Sol Ring","Some Unimplemented Card"]}
 *     -> {"id":"1","missing":["Some Unimplemented Card"]}
 *   {"id":"2","type":"runGame","players":[
 *       {"name":"PlayerA","commanderNames":["Krenko, Mob Boss"],"cardNames":["Mountain", ...99 entries incl. duplicates...],
 *        "logicRules":[{"type":"holdInstantUntilAttackTrigger","permanentNames":["Fire Lord Azula"]}]},
 *       {"name":"PlayerB","commanderNames":[...],"cardNames":[...]}
 *   ]}
 *     "logicRules" is optional (omitted/empty for a deck with no Logic file attached — see
 *     BiblioPLEX's deckStore.ts and docs/logic-file-guide.md) and is passed straight through to
 *     that seat's BiblioComputerPlayer7 instance; only "holdInstantUntilAttackTrigger" is
 *     recognized in v1, any other "type" is ignored here (the renderer already rejects unknown
 *     types at import time, so this is a defense-in-depth skip, not primary validation).
 *     While the game is running, one progress line is emitted per logged game action (same
 *     "id", no terminal fields), each pairing that action's log line with the resulting board
 *     state — this is what lets a caller pace a live-feeling replay one action at a time:
 *       {"id":"2","event":"progress","turn":7,"logLine":"...","players":[{"name":"PlayerA","life":32,"lost":false}, ...]}
 *     -> {"id":"2","winner":"Player PlayerA is the winner","turns":20,"gameMs":4259}
 *     -> {"id":"2","error":"..."} on failure
 */
public class Main {

    private static final Gson GSON = new Gson();
    private static PrintWriter out;

    /** CommanderFreeForAllMatch.initGame() unconditionally randomizes seating order via
     *  Collections.shuffle — fine for a real hosted table, but it breaks the assumption our UI
     *  makes that seat 1 (the first deck submitted, rendered top-left) goes first in turn order.
     *  Overriding this no-ops the shuffle so submission order IS turn order. */
    private static class SeatOrderedMatch extends CommanderFreeForAllMatch {
        SeatOrderedMatch(MatchOptions options) {
            super(options);
        }

        @Override
        protected void shufflePlayers() {
            // deliberately do nothing — keep addPlayer() call order
        }
    }

    public static void main(String[] args) throws Exception {
        // log4j.properties (Target=System.err) turned out not to be reliably honored — this is an
        // uber-jar built from many dependencies, and when several of them ship their own
        // log4j.properties on the classpath, Maven's assembly plugin doesn't merge them; whichever
        // one lands first in the merged jar wins, which in practice was NOT ours. Confirmed via a
        // captured raw stdout dump: H2's TableUtils INFO lines and a JarVersion NPE stack trace
        // were landing directly in stdout, interleaved with our JSON protocol lines and silently
        // corrupting some of them (fields present in the Java object just never made it into the
        // JSON the renderer received). Redirecting System.out itself, before anything else runs,
        // is bulletproof regardless of what any dependency's logging config does: everything in
        // the JVM that writes to System.out (log4j included) goes to stderr from this point on,
        // while `out` below is built from the REAL original stdout stream, captured first.
        java.io.PrintStream realStdout = System.out;
        System.setOut(System.err);
        out = new PrintWriter(new java.io.OutputStreamWriter(realStdout, StandardCharsets.UTF_8), true);

        System.err.println("[bridge] scanning card database...");
        long scanStart = System.currentTimeMillis();
        CardScanner.scan();
        System.err.println("[bridge] scan done in " + (System.currentTimeMillis() - scanStart) + "ms");

        out.println("{\"ready\":true}");

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) {
                continue;
            }
            JsonObject response = new JsonObject();
            String id = "?";
            try {
                JsonObject request = GSON.fromJson(line, JsonObject.class);
                id = request.get("id").getAsString();
                response.addProperty("id", id);
                String type = request.get("type").getAsString();
                switch (type) {
                    case "checkCards":
                        handleCheckCards(request, response);
                        break;
                    case "runGame":
                        handleRunGame(request, response);
                        break;
                    default:
                        response.addProperty("error", "Unknown request type: " + type);
                }
            } catch (Exception e) {
                response.addProperty("id", id);
                response.addProperty("error", e.toString());
            }
            out.println(GSON.toJson(response));
        }
    }

    private static void handleCheckCards(JsonObject request, JsonObject response) {
        List<String> names = new ArrayList<>();
        request.getAsJsonArray("cardNames").forEach(el -> names.add(el.getAsString()));

        List<String> missing = new ArrayList<>();
        for (String name : names) {
            CardInfo found = CardRepository.instance.findPreferredCoreExpansionCard(name, "");
            if (found == null) {
                missing.add(name);
            }
        }
        response.add("missing", GSON.toJsonTree(missing));
    }

    private static void handleRunGame(JsonObject request, JsonObject response) throws Exception {
        MatchOptions options = new MatchOptions("BiblioPLEX Playtest", "Commander Free For All", true);
        options.setAttackOption(MultiplayerAttackOption.MULTIPLE);
        options.setRange(RangeOfInfluence.ALL);
        options.setMullgianType(MulliganType.GAME_DEFAULT);
        // The first mulligan is free (redraw 7, keep all 7 — no card goes to the bottom); only
        // the second and later mulligans actually cost a card, per the London-mulligan-with-one-
        // free-mulligan house rule common in casual Commander pods.
        options.setFreeMulligans(1);
        options.setDeckType("Commander");

        CommanderFreeForAllMatch match = new SeatOrderedMatch(options);
        Map<String, CardInfo> cardInfoCache = new HashMap<>();

        int seat = 0;
        for (com.google.gson.JsonElement playerEl : request.getAsJsonArray("players")) {
            JsonObject playerObj = playerEl.getAsJsonObject();
            seat++;
            String name = playerObj.get("name").getAsString();

            List<String> commanderNames = new ArrayList<>();
            playerObj.getAsJsonArray("commanderNames").forEach(el -> commanderNames.add(el.getAsString()));
            List<String> cardNames = new ArrayList<>();
            playerObj.getAsJsonArray("cardNames").forEach(el -> cardNames.add(el.getAsString()));

            // See this file's top comment — only "holdInstantUntilAttackTrigger" is recognized;
            // any other rule "type" (from a future Logic file schema version) is silently
            // skipped rather than erroring, so a newer file doesn't break an older bridge build.
            Set<String> holdInstantsWhileNotAttacking = new HashSet<>();
            if (playerObj.has("logicRules")) {
                for (com.google.gson.JsonElement ruleEl : playerObj.getAsJsonArray("logicRules")) {
                    JsonObject rule = ruleEl.getAsJsonObject();
                    if (!"holdInstantUntilAttackTrigger".equals(rule.get("type").getAsString())) {
                        continue;
                    }
                    rule.getAsJsonArray("permanentNames").forEach(el -> holdInstantsWhileNotAttacking.add(el.getAsString()));
                }
            }

            File deckFile = File.createTempFile("biblioplex-deck-" + seat + "-", ".dck");
            deckFile.deleteOnExit();
            try (PrintWriter deckWriter = new PrintWriter(new FileWriter(deckFile), false)) {
                deckWriter.println("NAME:" + name + " deck");
                for (String commanderName : commanderNames) {
                    deckWriter.println("SB: 1 [XXX:1] " + commanderName);
                }
                Map<String, Integer> counts = new java.util.LinkedHashMap<>();
                for (String cardName : cardNames) {
                    counts.merge(cardName, 1, Integer::sum);
                }
                for (Map.Entry<String, Integer> entry : counts.entrySet()) {
                    deckWriter.println(entry.getValue() + " [XXX:1] " + entry.getKey());
                }
            }

            StringBuilder errors = new StringBuilder();
            DeckCardLists list = DeckImporter.importDeckFromFile(deckFile.getPath(), errors, false);
            Deck deck = Deck.load(list, false, false, cardInfoCache);
            deckFile.delete();

            if (deck.getMaindeckCards().size() < 90) {
                throw new IllegalArgumentException(
                        name + "'s deck only resolved " + deck.getMaindeckCards().size()
                                + " maindeck cards (expected ~99) — import messages: " + errors);
            }

            // ComputerPlayer7/6's constructor takes a raw minimax search-depth integer (no
            // named "difficulty" presets exist in XMage) — floor of 4, no ceiling. It also sets
            // its own per-decision think-time budget to depth*3 seconds internally
            // (ComputerPlayer6's constructor), so this is self-limiting rather than truly
            // unbounded, but cost still grows steeply (roughly exponentially, being a minimax
            // search) with depth. 10 is a deliberate, meaningful jump from the previous 6 for as
            // strong an AI as practical — safe to push this high specifically BECAUSE playback
            // pacing is fully decoupled from simulation speed (see the queue-draining design in
            // PlaytestTabView.tsx): nobody is waiting on the engine directly, only on the queue.
            //
            // BiblioComputerPlayer7 (our own fork, see that file) fixes two things stock
            // ComputerPlayer7 doesn't: it actually considers instant-speed plays during combat
            // steps (stock unconditionally auto-passes there, so a card like Fire Lord Azula's
            // "whenever you cast a spell while attacking" trigger could essentially never fire
            // from AI play), and it goes through our forked GameStateEvaluator2 (see that file)
            // which scores against ALL opponents in the pod instead of just one.
            // holdInstantsWhileNotAttacking (parsed above from this seat's optional Logic file)
            // is empty for a deck with no Logic file attached — identical to today's default.
            Player player = new BiblioComputerPlayer7(name, RangeOfInfluence.ALL, 10, holdInstantsWhileNotAttacking);
            match.addPlayer(player, deck);
        }

        match.startGame();
        Game game = match.getGames().get(match.getGames().size() - 1);
        game.setGameOptions(new GameOptions());

        UUID firstPlayerId = game.getPlayers().keySet().iterator().next();
        String requestId = response.get("id").getAsString();

        // XMage already builds a human-readable play-by-play for its own client (Player "casts
        // X targeting Y", "plays a land", etc. — see mage.game.stack.Spell / PlayerImpl) and
        // fires it as TableEvent.EventType.INFO. Reusing that instead of writing our own
        // narration logic means every card's phrasing stays correct without us maintaining it.
        //
        // Previously this just recorded the message and a *separate* thread polled game state
        // every 500ms — but the real game computes almost instantly (a full game finishes in
        // seconds), so a time-based poll and the actual actions had no real correspondence: one
        // 500ms tick could span several actions, or catch the board mid-resolution. Emitting a
        // full snapshot synchronously, right here inside the listener callback (i.e. on the game
        // thread itself, immediately after this one action resolved), gives one snapshot per
        // action with a guaranteed-stable state — exactly what "pace playback by action" needs,
        // and it removes the race/thread entirely.
        game.addTableEventListener(event -> {
            if (event.getEventType() == TableEvent.EventType.INFO && event.getMessage() != null) {
                emitSnapshot(requestId, game, event.getMessage());
            }
        });

        // One snapshot before anything happens, so opening hands/board state show up in the
        // playback queue even before the first logged action.
        emitSnapshot(requestId, game, "");

        long gameStart = System.currentTimeMillis();
        game.start(firstPlayerId);
        long gameMs = System.currentTimeMillis() - gameStart;
        // Final state (e.g. life totals after the last logged action resolved) in case the last
        // TableEvent.INFO didn't already capture it.
        emitSnapshot(requestId, game, "");

        response.addProperty("winner", game.getWinner());
        response.addProperty("turns", game.getTurnNum());
        response.addProperty("gameMs", gameMs);
    }

    private static void emitSnapshot(String requestId, Game game, String logLine) {
        JsonObject progress = new JsonObject();
        progress.addProperty("id", requestId);
        progress.addProperty("event", "progress");
        progress.addProperty("turn", game.getTurnNum());
        progress.addProperty("step", game.getStep() == null ? "" : game.getStep().getType().toString());
        UUID activePlayerId = game.getActivePlayerId();
        progress.addProperty("logLine", logLine);

        CommanderPlaysCountWatcher taxWatcher = game.getState().getWatcher(CommanderPlaysCountWatcher.class);

        JsonArray stackArr = new JsonArray();
        for (StackObject stackObject : game.getState().getStack()) {
            JsonObject so = new JsonObject();
            so.addProperty("id", stackObject.getId().toString());
            so.addProperty("name", stackObject.getName());
            // For a Spell, getSourceId() is the spell's own card, so this just matches "name"
            // again. For a triggered/activated ability, though, getName() returns the ability's
            // own text ("Whenever a player casts a spell...") rather than a real card name —
            // resolving the actual source permanent/card here is what lets the renderer show
            // that permanent's own art on the stack instead of failing to find "a card literally
            // named after some ability text" and falling back to a blank placeholder.
            mage.MageObject sourceObject = game.getObject(stackObject.getSourceId());
            so.addProperty("sourceName", sourceObject == null ? stackObject.getName() : sourceObject.getName());
            // Exact printing of the source, same reasoning as battlefield permanents (see
            // there) — lets the renderer resolve the right art (and foil status) instead of a
            // name-based guess.
            so.addProperty("setCode", sourceObject == null ? "" : sourceObject.getExpansionSetCode());
            so.addProperty("collectorNumber", sourceObject == null ? "" : sourceObject.getCardNumber());
            Player controller = game.getPlayer(stackObject.getControllerId());
            so.addProperty("controller", controller == null ? "" : controller.getName());
            // What this spell/ability is actually pointed at — resolved per chosen target UUID to
            // either a player or a battlefield permanent (whichever the renderer can draw an arrow
            // to). A target that resolves to neither (a card in a graveyard/hand, another stack
            // object like a counterspell's target, etc.) is skipped rather than guessed at — the
            // renderer has no stable on-screen anchor for those yet.
            JsonArray targetsArr = new JsonArray();
            mage.abilities.Ability stackAbility = stackObject.getStackAbility();
            if (stackAbility != null) {
                for (mage.target.Target target : stackAbility.getTargets()) {
                    for (UUID targetId : target.getTargets()) {
                        JsonObject t = new JsonObject();
                        Player targetPlayer = game.getPlayer(targetId);
                        if (targetPlayer != null) {
                            t.addProperty("playerName", targetPlayer.getName());
                        } else {
                            Permanent targetPermanent = game.getPermanent(targetId);
                            if (targetPermanent == null) {
                                continue;
                            }
                            t.addProperty("permanentId", targetPermanent.getId().toString());
                        }
                        targetsArr.add(t);
                    }
                }
            }
            so.add("targets", targetsArr);
            stackArr.add(so);
        }
        progress.add("stack", stackArr);

        JsonArray playersArr = new JsonArray();
        for (Player p : game.getState().getPlayers().values()) {
            JsonObject po = new JsonObject();
            po.addProperty("name", p.getName());
            po.addProperty("life", p.getLife());
            po.addProperty("lost", p.hasLost());
            po.addProperty("active", p.getId().equals(activePlayerId));
            po.addProperty("graveyardSize", p.getGraveyard().size());
            po.addProperty("librarySize", p.getLibrary().size());

            // 903.14a: 21+ combat damage from the SAME commander over the game is a loss —
            // tracked per-commander by XMage's own CommanderInfoWatcher (one instance per
            // commander, WatcherScope.CARD), the exact same watcher the engine's own
            // state-based-action loss check reads from (GameCommanderImpl.checkStateBasedActions
            // researched earlier). Every commander in the game (not just this player's own) is
            // checked for damage dealt TO this player, since the threat is always from an
            // OPPONENT'S commander.
            JsonArray commanderDamageArr = new JsonArray();
            for (Player otherPlayer : game.getState().getPlayers().values()) {
                for (UUID commanderId : game.getCommandersIds(otherPlayer, CommanderCardType.COMMANDER_OR_OATHBREAKER, false)) {
                    CommanderInfoWatcher damageWatcher = game.getState().getWatcher(CommanderInfoWatcher.class, commanderId);
                    if (damageWatcher == null) {
                        continue;
                    }
                    Integer amount = damageWatcher.getDamageToPlayer().get(p.getId());
                    if (amount == null || amount <= 0) {
                        continue;
                    }
                    Card commanderCard = game.getCard(commanderId);
                    JsonObject cd = new JsonObject();
                    cd.addProperty("commanderName", commanderCard == null ? "" : commanderCard.getName());
                    cd.addProperty("amount", amount);
                    commanderDamageArr.add(cd);
                }
            }
            po.add("commanderDamage", commanderDamageArr);

            // 104.1a / poison counters (e.g. infect) — a player with 10+ loses the game, but
            // there's no other visible signal for it otherwise (life total is a separate track),
            // so this had nowhere to surface in the UI before now.
            po.addProperty("poison", p.getCountersCount(mage.counters.CounterType.POISON));

            // Real card names, not just a count — a spectator tool studying how a deck plays is
            // exactly the case where seeing what's held (and not drawn) matters; there's no
            // "hidden information" concern the way there would be for an actual opponent in a
            // real match. Exact printing (setCode/collectorNumber) alongside the name, same
            // reasoning as battlefield permanents/stack objects — lets the renderer resolve the
            // right art AND foil status for a card sitting in hand/graveyard instead of a
            // name-only guess (foil in particular is tracked per-exact-printing, so a name-only
            // lookup could never tell a foil copy from a non-foil one).
            JsonArray handArr = new JsonArray();
            for (Card card : p.getHand().getCards(game)) {
                JsonObject c = new JsonObject();
                c.addProperty("name", card.getName());
                c.addProperty("setCode", card.getExpansionSetCode());
                c.addProperty("collectorNumber", card.getCardNumber());
                handArr.add(c);
            }
            po.add("hand", handArr);

            // Real cards for the graveyard too, for the same reason as hand — a click on a
            // player's graveyard badge should show what's actually in it, with correct art/foil.
            JsonArray graveyardArr = new JsonArray();
            for (Card card : p.getGraveyard().getCards(game)) {
                JsonObject c = new JsonObject();
                c.addProperty("name", card.getName());
                c.addProperty("setCode", card.getExpansionSetCode());
                c.addProperty("collectorNumber", card.getCardNumber());
                graveyardArr.add(c);
            }
            po.add("graveyard", graveyardArr);

            // Commander(s) currently sitting in the command zone (not on the battlefield), with
            // the commander tax they'd cost right now — 903.8: {2} for each previous time this
            // player has cast this commander from the command zone this game.
            // CommanderPlaysCountWatcher is a default GAME-scope watcher (auto-registered, no
            // explicit addWatcher needed) that XMage's own commander-tax cost modification
            // (Card.commanderCost / CommanderCostModification) reads from — reusing it here
            // instead of tracking casts ourselves keeps this in sync with the engine's own math.
            JsonArray commandZoneArr = new JsonArray();
            for (Card commander : game.getCommanderCardsFromCommandZone(p, CommanderCardType.ANY)) {
                JsonObject cz = new JsonObject();
                cz.addProperty("name", commander.getName());
                cz.addProperty("setCode", commander.getExpansionSetCode());
                cz.addProperty("collectorNumber", commander.getCardNumber());
                cz.addProperty("tax", taxWatcher == null ? 0 : 2 * taxWatcher.getPlaysCount(commander.getId()));
                commandZoneArr.add(cz);
            }
            po.add("commandZone", commandZoneArr);

            JsonArray battlefieldArr = new JsonArray();
            for (Permanent permanent : game.getBattlefield().getAllActivePermanents(p.getId())) {
                JsonObject perm = new JsonObject();
                perm.addProperty("id", permanent.getId().toString());
                perm.addProperty("name", permanent.getName());
                perm.addProperty("tapped", permanent.isTapped());
                perm.addProperty("attacking", permanent.isAttacking());
                // Who/what this attacker is actually attacking — a CombatGroup's defenderId can
                // be a player, a planeswalker, or a battle (comment on CombatGroup.defenderId).
                // Resolved to the DEFENDING PLAYER's name always (even a planeswalker attack is
                // ultimately "at" that player's board), plus the specific permanent id when the
                // target is a planeswalker/battle rather than the player directly — the renderer
                // needs one or the other to know where on screen to draw the arrow to.
                if (permanent.isAttacking()) {
                    for (mage.game.combat.CombatGroup group : game.getCombat().getGroups()) {
                        if (!group.getAttackers().contains(permanent.getId())) {
                            continue;
                        }
                        UUID defenderId = group.getDefenderId();
                        if (defenderId == null) {
                            break;
                        }
                        Player defendingPlayer = game.getPlayer(defenderId);
                        if (defendingPlayer != null) {
                            perm.addProperty("defendingPlayerName", defendingPlayer.getName());
                        } else {
                            Permanent defendingPermanent = game.getPermanent(defenderId);
                            if (defendingPermanent != null) {
                                Player controller = game.getPlayer(defendingPermanent.getControllerId());
                                perm.addProperty("defendingPlayerName", controller == null ? "" : controller.getName());
                                perm.addProperty("defendingPermanentId", defendingPermanent.getId().toString());
                            }
                        }
                        // Once blockers are declared, the renderer redirects this attacker's arrow
                        // to point at the blocker(s) instead of the original defender and recolors
                        // it — same CombatGroup, group.getBlockers() is empty until that step.
                        if (!group.getBlockers().isEmpty()) {
                            JsonArray blockerIds = new JsonArray();
                            for (UUID blockerId : group.getBlockers()) {
                                blockerIds.add(blockerId.toString());
                            }
                            perm.add("blockerIds", blockerIds);
                        }
                        break;
                    }
                }
                perm.addProperty("land", permanent.isLand(game));
                perm.addProperty("token", permanent.isToken());
                perm.addProperty("power", permanent.getPower().getValue());
                perm.addProperty("toughness", permanent.getToughness().getValue());
                // Total counter count (any type combined) — the renderer diffs this against the
                // previous snapshot to trigger a "counters added" sound cue; a single combined
                // count is enough for that without needing a per-type breakdown.
                perm.addProperty("counters", permanent.getCounters(game).getTotalCount());
                // Marked damage — cleared at cleanup, not subtracted from "toughness" itself
                // (that's a real rules distinction: toughness is a static/continuous-effect
                // value, damage is compared against it separately). The renderer shows the
                // remaining effective toughness (toughness - damage) in red until it clears.
                perm.addProperty("damage", permanent.getDamage());
                // The EXACT printing this permanent is — set code + collector number, the same
                // pair XMage itself uses internally for card-image lookups (see
                // PermanentImpl's own imageInfo construction). A bare card name can't
                // distinguish between two different chosen arts of the same card (basic lands
                // most commonly — a deck can have several differently-arted Forests), so the
                // renderer resolves art by this exact pair first, falling back to name-based
                // lookup only when it can't find a match (tokens, which don't have a real
                // printing the same way).
                //
                // A COPY (Clone effects, etc.) keeps its own physical card's setCode/cardNumber
                // unchanged by the copy — only its game characteristics (name, P/T, abilities)
                // become the copied thing's. Left alone, the renderer would resolve exact-printing
                // art for the COPYING card (e.g. Clone's own printing) while the name already says
                // the COPIED creature — a mismatch. getCopyFrom() is the actual object being
                // copied, which has its own real setCode/cardNumber to resolve instead.
                mage.MageObject artSource = permanent.isCopy() && permanent.getCopyFrom() != null ? permanent.getCopyFrom() : permanent;
                perm.addProperty("setCode", artSource.getExpansionSetCode());
                perm.addProperty("collectorNumber", artSource.getCardNumber());

                // Lets the renderer nest an Equipment/Aura visually behind whatever it's
                // attached to instead of listing it as an unrelated separate card.
                UUID attachedTo = permanent.getAttachedTo();
                if (attachedTo != null) {
                    perm.addProperty("attachedTo", attachedTo.toString());
                }

                // Battlefield display order: creatures, then artifacts, then enchantments, then
                // anything else (planeswalkers, battles, ...) — a permanent can be more than one
                // of these (an artifact creature), so check in that priority order.
                List<CardType> cardTypes = permanent.getCardType(game);
                int typeRank;
                if (cardTypes.contains(CardType.CREATURE)) {
                    typeRank = 0;
                } else if (cardTypes.contains(CardType.ARTIFACT)) {
                    typeRank = 1;
                } else if (cardTypes.contains(CardType.ENCHANTMENT)) {
                    typeRank = 2;
                } else {
                    typeRank = 3;
                }
                perm.addProperty("typeRank", typeRank);

                battlefieldArr.add(perm);
            }
            po.add("battlefield", battlefieldArr);

            playersArr.add(po);
        }
        progress.add("players", playersArr);
        out.println(GSON.toJson(progress));
    }
}
