import { describe, expect, it } from 'vitest';
import {
  createGame, drawChoice, playCard, projectForPlayer, resolvePendingEffect, selectScholarCard,
  type Card, type GameState,
} from '../supabase/functions/_shared/game';
import { STARTER_COUNTS } from './lib/presets';

const fixed = () => 0.31;
const card = (rank: number, suffix = 'x'): Card => ({ id: `${rank}-${suffix}`, rank });

function base(): GameState {
  return createGame(['A', 'B', 'C'], { ...STARTER_COUNTS, 13: 2 }, fixed);
}

describe('game engine', () => {
  it('chooses the starting player from the supplied random value', () => {
    const game = createGame(['A', 'B', 'C'], { ...STARTER_COUNTS, 13: 2 }, () => 0.99);
    expect(game.turnIndex).toBe(2);
    expect(game.events.at(-1)?.text).toContain('先行はC');
    expect(projectForPlayer(game, 'player-1').turnPlayerId).toBe('player-3');
  });

  it('adds configurable joker cards to the deck', () => {
    const game = createGame(['A', 'B'], { 0: 1, 1: 3 }, fixed);
    const allCards = [game.reincarnationCard, ...game.deck, ...game.players.flatMap((player) => player.hand)].filter(Boolean) as Card[];
    expect(allCards.filter((item) => item.rank === 0)).toHaveLength(1);
  });

  it('never exposes another player hand or hidden guard state', () => {
    const game = base();
    game.players[1].guarded = true;
    game.players[1].hand = [card(13)];
    const view = projectForPlayer(game, 'player-1');
    expect(view.players[1].ownHand).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('guarded');
    expect(JSON.stringify(view)).not.toContain('13-x');
  });

  it('reveals effect choices only to the acting player', () => {
    const game = base();
    game.phase = 'resolve';
    game.players[1].hand = [card(5, 'left'), card(13, 'right')];
    game.pendingEffect = {
      kind: 'public-execution', actorId: 'player-1', targetId: 'player-2', blockReincarnation: false,
    };
    const actor = projectForPlayer(game, 'player-1');
    const bystander = projectForPlayer(game, 'player-3');
    expect(actor.pendingTargetCards.map((item) => item.rank)).toEqual([5, 13]);
    expect(actor.pendingTargetHandCount).toBe(2);
    expect(bystander.pendingEffect).toBeNull();
    expect(bystander.pendingTargetCards).toEqual([]);
  });

  it('reveals every final hand when the game ends', () => {
    const game = base();
    game.players[1].hand = [card(12, 'final')];
    game.result = { winners: ['player-2'], reason: 'deck-exhausted', highRank: 12 };
    game.phase = 'ended';
    const view = projectForPlayer(game, 'player-1');
    expect(view.players[1].ownHand?.[0].rank).toBe(12);
  });

  it('shows both draw choices without revealing scholar eligibility in the projection', () => {
    const game = base();
    game.players[0].pendingScholar = true;
    const view = projectForPlayer(game, 'player-1');
    expect(JSON.stringify(view)).not.toContain('pendingScholar');
    expect(view.phase).toBe('draw');
  });

  it('punishes an invalid three-card look with a random discard and ends the turn', () => {
    const game = base();
    game.players[0].hand = [card(5, 'held')];
    const next = drawChoice(game, 'player-1', 'three', () => 0);
    expect(next.discard.length).toBe(1);
    expect(next.players[0].hand).toHaveLength(1);
    expect(next.turnIndex).toBe(1);
  });

  it('taunts only the forgetful player when scholar draw is missed', () => {
    const game = base();
    game.players[0].pendingScholar = true;
    const next = drawChoice(game, 'player-1', 'one', fixed);
    const own = projectForPlayer(next, 'player-1');
    const other = projectForPlayer(next, 'player-2');
    expect(own.events.at(-1)?.text).toBe('忘れてやーんの');
    expect(other.events.some((event) => event.text === '忘れてやーんの')).toBe(false);
  });

  it('keeps guard and scholar memory through a skipped turn', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(11), card(3)];
    game.players[1].guarded = true;
    game.players[1].pendingScholar = true;
    const next = playCard(game, 'player-1', '11-x', {}, fixed);
    expect(next.turnIndex).toBe(2);
    expect(next.players[1].guarded).toBe(true);
    expect(next.players[1].pendingScholar).toBe(true);
  });

  it('blocks a targeted effect without exposing the reason', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(3), card(8)];
    game.players[1].guarded = true;
    const next = playCard(game, 'player-1', '3-x', { targetId: 'player-2' }, fixed);
    expect(next.events.at(-1)?.text).toBe('何も起きなかった。');
    expect(next.events.at(-1)?.text).not.toContain('守護');
  });

  it('keeps the first rank 1 inactive', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(1), card(8, 'keep')];
    const next = playCard(game, 'player-1', '1-x', {}, fixed);
    expect(next.rankOnePlayed).toBe(1);
    expect(next.pendingEffect).toBeNull();
  });

  it('activates every rank 1 after the first, even after the grave is recycled', () => {
    const game = base();
    game.phase = 'action';
    game.rankOnePlayed = 2;
    game.discard = [];
    game.players[0].hand = [card(1), card(8, 'keep')];
    game.players[1].hand = [card(4, 'target')];
    const next = playCard(game, 'player-1', '1-x', { targetId: 'player-2' }, fixed);
    expect(next.rankOnePlayed).toBe(3);
    expect(next.pendingEffect?.kind).toBe('public-execution');
    expect(projectForPlayer(next, 'player-1').rankOnePlayed).toBe(3);
  });

  it('shows a rank 1 public-execution hand only to its user', () => {
    const game = base();
    game.phase = 'action';
    game.rankOnePlayed = 1;
    game.players[0].hand = [card(1), card(8, 'keep')];
    game.players[1].hand = [card(4, 'target')];
    const next = playCard(game, 'player-1', '1-x', { targetId: 'player-2' }, fixed);
    const actorEvents = projectForPlayer(next, 'player-1').events;
    const targetEvents = projectForPlayer(next, 'player-2').events;
    const bystanderEvents = projectForPlayer(next, 'player-3').events;
    expect(actorEvents.some((event) => event.revealTitle === '公開処刑')).toBe(true);
    expect(targetEvents.some((event) => event.revealTitle === '公開処刑')).toBe(false);
    expect(bystanderEvents.some((event) => event.revealTitle === '公開処刑')).toBe(false);
  });

  it('uses the first rank 6 for a private face-to-face reveal without elimination', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(6), card(9, 'actor')];
    game.players[1].hand = [card(4, 'target')];
    const next = playCard(game, 'player-1', '6-x', { targetId: 'player-2' }, fixed);
    expect(next.players[0].eliminated).toBe(false);
    expect(next.players[1].eliminated).toBe(false);
    expect(projectForPlayer(next, 'player-1').events.at(-1)?.text).toBe('対面：Bの手札は4。');
    expect(projectForPlayer(next, 'player-2').events.at(-1)?.text).toBe('対面：Aの手札は9。');
    expect(projectForPlayer(next, 'player-3').events.some((event) => event.text.includes('手札は'))).toBe(false);
  });

  it('uses the second rank 6 for a duel and eliminates the lower hand', () => {
    const game = base();
    game.phase = 'action';
    game.rankSixPlayed = 1;
    game.discard = [card(6, 'first')];
    game.players[0].hand = [card(6), card(9, 'actor')];
    game.players[1].hand = [card(4, 'target')];
    const next = playCard(game, 'player-1', '6-x', { targetId: 'player-2' }, fixed);
    expect(next.players[0].eliminated).toBe(false);
    expect(next.players[1].eliminated).toBe(true);
    expect(projectForPlayer(next, 'player-1').events.at(-1)?.text).toBe('対決：Bの手札は4。');
  });

  it('eliminates the rank 6 user when their remaining hand is lower', () => {
    const game = base();
    game.phase = 'action';
    game.rankSixPlayed = 1;
    game.discard = [card(6, 'first')];
    game.players[0].hand = [card(6), card(4, 'actor')];
    game.players[1].hand = [card(9, 'target')];
    const next = playCard(game, 'player-1', '6-x', { targetId: 'player-2' }, fixed);
    expect(next.players[0].eliminated).toBe(true);
    expect(next.players[0].hand).toHaveLength(0);
    expect(next.players[1].eliminated).toBe(false);
    expect(next.turnIndex).toBe(1);
  });

  it('counts a physical rank 6 even when its target is guarded', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(6), card(9, 'keep')];
    game.players[1].hand = [card(4, 'guarded')];
    game.players[1].guarded = true;
    const afterBlockedSix = playCard(game, 'player-1', '6-x', { targetId: 'player-2' }, fixed);
    expect(afterBlockedSix.rankSixPlayed).toBe(1);

    afterBlockedSix.phase = 'action';
    afterBlockedSix.turnIndex = 1;
    afterBlockedSix.players[1].hand = [card(6, 'second'), card(4, 'actor')];
    afterBlockedSix.players[2].hand = [card(9, 'target')];
    const next = playCard(afterBlockedSix, 'player-2', '6-second', { targetId: 'player-3' }, fixed);
    expect(next.players[1].eliminated).toBe(true);
  });

  it('repairs an uncounted guarded rank 6 from an already-running game', () => {
    const game = base();
    game.phase = 'action';
    game.rankSixPlayed = 0;
    game.discard = [card(6, 'previously-blocked')];
    game.players[0].hand = [card(6), card(4, 'actor')];
    game.players[1].hand = [card(9, 'target')];
    const next = playCard(game, 'player-1', '6-x', { targetId: 'player-2' }, fixed);
    expect(next.rankSixPlayed).toBe(2);
    expect(next.players[0].eliminated).toBe(true);
  });

  it('continues without elimination when a rank 6 duel is tied', () => {
    const game = base();
    game.phase = 'action';
    game.rankSixPlayed = 1;
    game.discard = [card(6, 'first')];
    game.players[0].hand = [card(6), card(8, 'actor')];
    game.players[1].hand = [card(8, 'target')];
    const next = playCard(game, 'player-1', '6-x', { targetId: 'player-2' }, fixed);
    expect(next.players[0].eliminated).toBe(false);
    expect(next.players[1].eliminated).toBe(false);
    expect(next.events.some((event) => event.text === '対決は引き分け。勝負はそのまま続く。')).toBe(true);
  });

  it('uses every rank 6 after the first for a duel', () => {
    const game = base();
    game.phase = 'action';
    game.rankSixPlayed = 2;
    game.discard = [card(6, 'first'), card(6, 'second')];
    game.players[0].hand = [card(6), card(9, 'actor')];
    game.players[1].hand = [card(4, 'target')];
    const next = playCard(game, 'player-1', '6-x', { targetId: 'player-2' }, fixed);
    expect(next.players[0].eliminated).toBe(false);
    expect(next.players[1].eliminated).toBe(true);
    expect(projectForPlayer(next, 'player-1').events.at(-1)?.revealTitle).toBe('対決');
  });

  it('remembers that rank 6 has appeared even after the grave is recycled', () => {
    const game = base();
    game.phase = 'action';
    game.rankSixPlayed = 2;
    game.discard = [];
    game.players[0].hand = [card(6), card(9, 'actor')];
    game.players[1].hand = [card(4, 'target')];
    const next = playCard(game, 'player-1', '6-x', { targetId: 'player-2' }, fixed);
    expect(next.players[1].eliminated).toBe(true);
    expect(next.rankSixPlayed).toBe(3);
  });

  it('prevents rank 13 reincarnation under rank 9', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(9), card(2)];
    game.players[1].hand = [card(13)];
    game.deck = [card(4, 'drawn'), ...game.deck];
    let next = playCard(game, 'player-1', '9-x', { targetId: 'player-2' }, fixed);
    const target = next.players[1];
    const thirteenIndex = target.hand.findIndex((item) => item.rank === 13);
    next = resolvePendingEffect(next, 'player-1', thirteenIndex);
    expect(next.players[1].eliminated).toBe(true);
    expect(next.reincarnationCard).not.toBeNull();
  });

  it('shows a rank 9 public-execution hand only to its user', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(9), card(8, 'keep')];
    game.players[1].hand = [card(4, 'target')];
    const next = playCard(game, 'player-1', '9-x', { targetId: 'player-2' }, fixed);
    const actorEvents = projectForPlayer(next, 'player-1').events;
    const targetEvents = projectForPlayer(next, 'player-2').events;
    const bystanderEvents = projectForPlayer(next, 'player-3').events;
    expect(actorEvents.some((event) => event.revealTitle === '公開処刑')).toBe(true);
    expect(targetEvents.some((event) => event.revealTitle === '公開処刑')).toBe(false);
    expect(bystanderEvents.some((event) => event.revealTitle === '公開処刑')).toBe(false);
  });

  it('processes rank 12 in seat order and replaces every unguarded hand', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(12), card(2, 'keep')];
    game.players[1].hand = [card(3, 'b')];
    game.players[2].hand = [card(4, 'c')];
    const next = playCard(game, 'player-1', '12-x', {}, fixed);
    const discardedIds = next.discard.map((item) => item.id);
    expect(discardedIds.indexOf('3-b')).toBeLessThan(discardedIds.indexOf('4-c'));
    expect(next.players[1].hand).toHaveLength(1);
    expect(next.players[2].hand).toHaveLength(1);
  });

  it('recycles the grave during an effect and schedules the end of the game', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(10), card(2, 'old')];
    game.deck = [card(6, 'last')];
    const next = playCard(game, 'player-1', '10-x', {}, fixed);
    expect(next.result?.reason).toBe('deck-exhausted');
    expect(next.players[0].hand[0]?.rank).toBe(6);
  });

  it('discards both rank 13 cards and reincarnates when a second 13 is drawn', () => {
    const game = base();
    game.players[0].hand = [card(13, 'held')];
    game.deck = [card(4, 'spare'), card(13, 'drawn')];
    game.reincarnationCard = card(8, 'reborn');
    const next = drawChoice(game, 'player-1', 'one', fixed);
    expect(next.discard.map((item) => item.id)).toEqual(expect.arrayContaining(['13-held', '13-drawn']));
    expect(next.players[0].hand.map((item) => item.id)).toEqual(['8-reborn']);
    expect(next.players[0].eliminated).toBe(false);
    expect(next.turnIndex).toBe(1);
  });

  it('discards both rank 13 cards after selecting the second one from three futures', () => {
    const game = base();
    game.phase = 'scholar-select';
    game.players[0].hand = [card(13, 'held')];
    game.scholarCandidates = [card(13, 'chosen'), card(4, 'other-a'), card(5, 'other-b')];
    game.reincarnationCard = card(7, 'reborn');
    const next = selectScholarCard(game, 'player-1', '13-chosen', fixed);
    expect(next.discard.map((item) => item.id)).toEqual(expect.arrayContaining(['13-held', '13-chosen']));
    expect(next.players[0].hand.map((item) => item.id)).toEqual(['7-reborn']);
    expect(next.turnIndex).toBe(1);
  });

  it('does not eliminate a rank 13 discarded by rank 1 public execution when reincarnation is unavailable', () => {
    const game = base();
    game.phase = 'action';
    game.rankOnePlayed = 1;
    game.reincarnationCard = null;
    game.deck = [card(8, 'spare'), card(4, 'drawn')];
    game.players[0].hand = [card(1), card(2, 'keep')];
    game.players[1].hand = [card(13, 'target')];
    const pending = playCard(game, 'player-1', '1-x', { targetId: 'player-2' }, fixed);
    const next = resolvePendingEffect(pending, 'player-1', 0);
    expect(next.players[1].eliminated).toBe(false);
    expect(next.players[1].hand.map((item) => item.id)).toEqual(['4-drawn']);
  });

  it('treats the joker as value 10 for guesses and final comparison', () => {
    const guessed = base();
    guessed.phase = 'action';
    guessed.players[0].hand = [card(2), card(4, 'keep')];
    guessed.players[1].hand = [card(0, 'joker')];
    const afterGuess = playCard(guessed, 'player-1', '2-x', { targetId: 'player-2', guess: 10 }, fixed);
    expect(afterGuess.players[1].eliminated).toBe(true);

    const final = base();
    final.phase = 'action';
    final.endAfterResolution = true;
    final.players[0].hand = [card(11), card(0, 'joker')];
    final.players[1].hand = [card(9, 'other')];
    final.players[2].eliminated = true;
    const result = playCard(final, 'player-1', '11-x', {}, fixed);
    expect(result.result?.highRank).toBe(10);
    expect(result.result?.winners).toEqual(['player-1']);
  });

  it('uses a joker as the declared effect while rejecting 9 and 13', () => {
    const game = base();
    game.phase = 'action';
    game.players[0].hand = [card(0, 'joker'), card(3, 'old')];
    game.deck = [card(8, 'spare'), card(5, 'new')];
    const next = playCard(game, 'player-1', '0-joker', { declaredRank: 10 }, fixed);
    expect(next.discard.map((item) => item.id)).toEqual(expect.arrayContaining(['0-joker', '3-old']));
    expect(next.players[0].hand.map((item) => item.id)).toEqual(['5-new']);

    const invalid = base();
    invalid.phase = 'action';
    invalid.players[0].hand = [card(0, 'invalid'), card(4, 'keep')];
    expect(() => playCard(invalid, 'player-1', '0-invalid', { declaredRank: 9 }, fixed)).toThrow(/9と13以外/);
    expect(() => playCard(invalid, 'player-1', '0-invalid', { declaredRank: 13 }, fixed)).toThrow(/9と13以外/);
  });

  it('does not count a joker declared as the first rank 1 or rank 6', () => {
    const asOne = base();
    asOne.phase = 'action';
    asOne.rankOnePlayed = 0;
    asOne.players[0].hand = [card(0, 'one'), card(8, 'keep')];
    const afterOne = playCard(asOne, 'player-1', '0-one', { declaredRank: 1 }, fixed);
    expect(afterOne.rankOnePlayed).toBe(0);
    expect(afterOne.pendingEffect).toBeNull();

    const asSix = base();
    asSix.phase = 'action';
    asSix.rankSixPlayed = 0;
    asSix.players[0].hand = [card(0, 'six'), card(9, 'actor')];
    asSix.players[1].hand = [card(4, 'target')];
    const afterSix = playCard(asSix, 'player-1', '0-six', { declaredRank: 6, targetId: 'player-2' }, fixed);
    expect(afterSix.rankSixPlayed).toBe(0);
    expect(afterSix.players[1].eliminated).toBe(false);
    expect(projectForPlayer(afterSix, 'player-1').events.at(-1)?.revealTitle).toBe('対面');
  });

  it('lets a joker reuse later rank 1 and rank 6 effects without increasing their counters', () => {
    const asOne = base();
    asOne.phase = 'action';
    asOne.rankOnePlayed = 1;
    asOne.players[0].hand = [card(0, 'one'), card(8, 'keep')];
    asOne.players[1].hand = [card(4, 'target')];
    const afterOne = playCard(asOne, 'player-1', '0-one', { declaredRank: 1, targetId: 'player-2' }, fixed);
    expect(afterOne.rankOnePlayed).toBe(1);
    expect(afterOne.pendingEffect?.kind).toBe('public-execution');

    const asSix = base();
    asSix.phase = 'action';
    asSix.rankSixPlayed = 1;
    asSix.players[0].hand = [card(0, 'six'), card(9, 'actor')];
    asSix.players[1].hand = [card(4, 'target')];
    const afterSix = playCard(asSix, 'player-1', '0-six', { declaredRank: 6, targetId: 'player-2' }, fixed);
    expect(afterSix.rankSixPlayed).toBe(1);
    expect(afterSix.players[1].eliminated).toBe(true);
    expect(projectForPlayer(afterSix, 'player-1').events.at(-1)?.revealTitle).toBe('対決');
  });
});
