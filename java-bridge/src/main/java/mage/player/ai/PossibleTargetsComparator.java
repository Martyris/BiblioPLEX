package mage.player.ai;

import mage.MageItem;
import mage.MageObject;
import mage.cards.Card;
import mage.constants.Zone;
import mage.filter.common.FilterLandPermanent;
import mage.counters.CounterType;
import mage.game.Game;
import mage.game.permanent.Permanent;
import mage.game.stack.StackObject;
import mage.player.ai.score.GameStateEvaluator2;
import mage.players.PlayableObjectsList;
import mage.players.Player;
import mage.target.Target;

import java.util.Comparator;
import java.util.UUID;

/**
 * AI related code - compare and sort possible targets due target/effect type
 *
 * BiblioPLEX fork — see the research this was built from: upstream's ANY_MOST_VALUABLE_FIRST
 * ranks a plain library/hand Card (as opposed to a battlefield Permanent) by getScoreFromLife(),
 * which for a Card falls through to comparing a creature's TOUGHNESS against an instant/sorcery's
 * MANA VALUE — two entirely different, incomparable scales, directly compared via Integer.compare
 * as if they meant the same thing. This is exactly how a "look at the top N cards, put one into
 * your hand" effect (Prophetic Bolt, copied by Fire Lord Azula) picked an uncastable creature
 * over a perfectly good, affordable instant/sorcery: the creature's toughness simply outscored
 * the spell's mana value. Confirmed via BiblioComputerPlayer7's debug-decisions.log trace and by
 * reading this exact upstream method (raw GitHub source, magefree/mage master branch) before
 * writing this fork. Fixed by adding BY_CASTABLE (a mana-affordability check, ahead of
 * BY_BIGGER_SCORE in the comparator chain) for plain Cards only — Permanent/Player comparisons
 * are untouched, since those are already scored sensibly via GameStateEvaluator2.evaluatePermanent
 * or life totals.
 *
 * Second fix in the same fork: BY_LAND (used by ANY_UNPLAYABLE_AND_USELESS, i.e. discard-effect
 * choices) unconditionally protects every land the player holds from being discarded, no matter
 * how many lands they already control. Reasonable while genuinely land-screwed; actively wrong
 * once flooded — a real game showed Frantic Search's discard step give up a hand full of
 * castable spells purely to protect lands the player didn't need. See
 * controllerHasEnoughLands()/ENOUGH_LANDS_TO_STOP_PROTECTING below.
 *
 * Shadowed into the shaded jar the same way GameStateEvaluator2 is — see that class's own comment
 * and java-bridge/pom.xml's shade-plugin filter for why a same-package, same-name replacement is
 * needed instead of subclassing (this class isn't overridden/injected anywhere; it's just
 * constructed directly by PossibleTargetsSelector via `new PossibleTargetsComparator(...)`, so
 * whichever class file wins the shade merge is what actually runs).
 *
 * @author JayDi85
 */
public class PossibleTargetsComparator {

    UUID abilityControllerId;
    Game game;
    PlayableObjectsList playableItems = new PlayableObjectsList();

    public PossibleTargetsComparator(UUID abilityControllerId, Game game) {
        this.abilityControllerId = abilityControllerId;
        this.game = game;
        // Upstream only populates this for the discard-sorting path (an explicit external call
        // to findPlayableItems() before using ANY_UNPLAYABLE_AND_USELESS) — BY_CASTABLE below
        // needs it for the "most valuable" path too, so it's populated unconditionally here.
        findPlayableItems();
    }

    public void findPlayableItems() {
        this.playableItems = this.game.getPlayer(this.abilityControllerId).getPlayableObjects(this.game, Zone.ALL);
    }

    private int getScoreFromBattlefield(MageItem item) {
        if (item instanceof Permanent) {
            // use battlefield score instead simple life
            return GameStateEvaluator2.evaluatePermanent((Permanent) item, game, false);
        } else {
            return getScoreFromLife(item);
        }
    }

    private String getName(MageItem item) {
        if (item instanceof Player) {
            return ((Player) item).getName();
        } else if (item instanceof MageObject) {
            return ((MageObject) item).getName();
        } else {
            return "unknown";
        }
    }

    public static int getLifeForDamage(MageItem item, Game game) {
        int res = 0;
        if (item instanceof Player) {
            res = ((Player) item).getLife();
        } else if (item instanceof Card) {
            Card card = (Card) item;
            if (card.isPlaneswalker(game)) {
                res = card.getCounters(game).getCount(CounterType.LOYALTY);
            } else if (card.isBattle(game)) {
                res = card.getCounters(game).getCount(CounterType.DEFENSE);
            } else {
                int damage = 0;
                if (card instanceof Permanent) {
                    damage = ((Permanent) card).getDamage();
                }
                res = Math.max(0, card.getToughness().getValue() - damage);
            }
        }
        return res;
    }

    private int getScoreFromLife(MageItem item) {
        // TODO: replace permanent/card life by battlefield score?
        int res = getLifeForDamage(item, game);
        if (res == 0 && item instanceof Card) {
            res = ((Card) item).getManaValue();
        }
        return res;
    }

    private boolean isMyItem(MageItem item) {
        return PossibleTargetsSelector.isMyItem(this.abilityControllerId, item);
    }

    // A plain library/hand Card, not a Permanent (a Permanent IS a Card in XMage's hierarchy, so
    // this deliberately excludes those — battlefield targets are already scored sensibly and
    // shouldn't go through a mana-affordability check that doesn't apply to them).
    private boolean isPlainCard(MageItem item) {
        return item instanceof Card && !(item instanceof Permanent);
    }

    // Mana-affordability as a castability proxy — zone-independent on purpose: a card offered by
    // a "look at top N" effect is typically still in Zone.LIBRARY at choice time, not yet moved
    // to hand, so a strict "is this legally playable from its current zone right now" check would
    // reject every candidate uniformly and never actually discriminate between them. Whether the
    // player could afford this card's cost is what actually matters for "is this worth taking."
    private boolean isCastableCard(MageItem item) {
        if (!isPlainCard(item)) {
            return false;
        }
        Card card = (Card) item;
        Player controller = game.getPlayer(this.abilityControllerId);
        if (controller == null) {
            return false;
        }
        return controller.getManaAvailable(game).enough(card.getManaCost().getMana());
    }

    // Only worth protecting lands from discard while the controller is actually short on them —
    // a real game showed Frantic Search's discard step giving up a hand full of castable spells
    // purely to keep lands the player didn't need (already comfortably ahead on lands in play,
    // and Frantic Search itself untaps lands, so extras in hand had little marginal value here).
    // Gated on a flat threshold rather than reversing BY_LAND outright, since a land-hungry deck
    // still genuinely wants this protection while actually short on lands.
    private static final int ENOUGH_LANDS_TO_STOP_PROTECTING = 6;

    private boolean controllerHasEnoughLands() {
        Player controller = game.getPlayer(this.abilityControllerId);
        if (controller == null) {
            return false;
        }
        return game.getBattlefield().countAll(new FilterLandPermanent(), controller.getId(), game) >= ENOUGH_LANDS_TO_STOP_PROTECTING;
    }

    // Deprioritized, not excluded — doubling up on one target is sometimes genuinely correct
    // (e.g. lethal burn), but a real game showed multiple simultaneous triggered abilities (3
    // Junk Winder triggers from 3 tokens entering at once) and multiple copies of the same spell
    // (Repulse, copied by Fire Lord Azula) all independently pick the exact same "biggest
    // threat" target. That's not a bad choice each time in isolation — it's that nothing about
    // the board changes between one sibling's target choice and the next (each is chosen while
    // the earlier ones sit unresolved on the stack), so the same "best" answer keeps winning
    // with no awareness an earlier, still-pending effect already claimed it. Checking the stack
    // directly (not just this ability's own siblings) also correctly backs off an opponent's
    // already-targeted permanent, not just this player's own repeats.
    private boolean isAlreadyTargetedOnStack(MageItem item) {
        UUID id = item.getId();
        for (StackObject stackObject : game.getStack()) {
            for (Target target : stackObject.getStackAbility().getTargets()) {
                if (target.contains(id)) {
                    return true;
                }
            }
        }
        return false;
    }

    // sort by name-id at the end, so AI will use same choices in all simulations
    private final Comparator<MageItem> BY_NAME = (o1, o2) -> getName(o2).compareTo(getName(o1));
    private final Comparator<MageItem> BY_ID = Comparator.comparing(MageItem::getId);

    private final Comparator<MageItem> BY_ME = (o1, o2) -> Boolean.compare(
            isMyItem(o2),
            isMyItem(o1)
    );

    private final Comparator<MageItem> BY_BIGGER_SCORE = (o1, o2) -> Integer.compare(
            getScoreFromBattlefield(o2),
            getScoreFromBattlefield(o1)
    );

    private final Comparator<MageItem> BY_CASTABLE = (o1, o2) -> Boolean.compare(
            isCastableCard(o2),
            isCastableCard(o1)
    );

    private final Comparator<MageItem> BY_NOT_ALREADY_TARGETED_ON_STACK = (o1, o2) -> Boolean.compare(
            isAlreadyTargetedOnStack(o1),
            isAlreadyTargetedOnStack(o2)
    );

    private final Comparator<MageItem> BY_PLAYABLE = (o1, o2) -> Boolean.compare(
            this.playableItems.containsObject(o2.getId()),
            this.playableItems.containsObject(o1.getId())
    );

    private final Comparator<MageItem> BY_LAND = (o1, o2) -> {
        if (controllerHasEnoughLands()) {
            return 0; // not worth protecting further — defer to playability/value comparators
        }
        boolean isLand1 = o1 instanceof MageObject && ((MageObject) o1).isLand(game);
        boolean isLand2 = o2 instanceof MageObject && ((MageObject) o2).isLand(game);
        return Boolean.compare(isLand2, isLand1);
    };

    private final Comparator<MageItem> BY_TYPE_PLAYER = (o1, o2) -> Boolean.compare(
            o2 instanceof Player,
            o1 instanceof Player
    );

    private final Comparator<MageItem> BY_TYPE_PLANESWALKER = (o1, o2) -> {
        boolean isPlaneswalker1 = o1 instanceof MageObject && ((MageObject) o1).isPlaneswalker(game);
        boolean isPlaneswalker2 = o2 instanceof MageObject && ((MageObject) o2).isPlaneswalker(game);
        return Boolean.compare(isPlaneswalker2, isPlaneswalker1);
    };

    private final Comparator<MageItem> BY_TYPE_BATTLE = (o1, o2) -> {
        boolean isBattle1 = o1 instanceof MageObject && ((MageObject) o1).isBattle(game);
        boolean isBattle2 = o2 instanceof MageObject && ((MageObject) o2).isBattle(game);
        return Boolean.compare(isBattle2, isBattle1);
    };

    private final Comparator<MageItem> BY_TYPES = BY_TYPE_PLANESWALKER
            .thenComparing(BY_TYPE_BATTLE)
            .thenComparing(BY_TYPE_PLAYER);

    /**
     * Default sorting for good effects - put the biggest items to the top
     */
    public final Comparator<MageItem> ANY_MOST_VALUABLE_FIRST = BY_TYPES
            .thenComparing(BY_NOT_ALREADY_TARGETED_ON_STACK)
            .thenComparing(BY_CASTABLE)
            .thenComparing(BY_BIGGER_SCORE)
            .thenComparing(BY_NAME)
            .thenComparing(BY_ID);
    public final Comparator<MageItem> ANY_MOST_VALUABLE_LAST = ANY_MOST_VALUABLE_FIRST.reversed();

    /**
     * Sorting for discard effects - put the biggest unplayable at the top, lands at the end anyway
     */
    public final Comparator<MageItem> ANY_UNPLAYABLE_AND_USELESS = BY_LAND.reversed()
            .thenComparing(BY_PLAYABLE.reversed())
            .thenComparing(ANY_MOST_VALUABLE_FIRST);

}
