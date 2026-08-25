import { describe, expect, it } from 'vitest';
import {
  createGame, drawChoice, playCard, projectForPlayer, resolvePendingEffect,
  type Card, type GameState,
} from '../supabase/functions/_shared/game';
import { STARTER_COUNTS } from './lib/presets';

const fixed = () => 0.31;
const card = (rank: number, suffix = 'x'): Card => ({ id: `${rank}-${suffix}`, rank });

function base(): GameState {
  return createGame(['A', 'B', 'C'], { ...STARTER_COUNTS, 13: 2 }, fixed);
}

describe('game engine', () => {
  it('never exposes another player hand or hidden guard state', () => {
    const game = base();
    game.players[1].guarded = true;
    game.players[1].hand = [card(13)];
    const view = projectForPlayer(game, 'player-1');
    expect(view.players[1].ownHand).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('guarded');
    expect(JSON.stringify(view)).not.toContain('13-x');
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
});
