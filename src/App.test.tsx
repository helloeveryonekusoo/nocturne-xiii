import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerView } from '../supabase/functions/_shared/game';
import App, { CardRevealModal, GameMotionLayer, TauntNotice } from './App';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Nocturne XIII interface', () => {
  it('renders the primary room actions and product identity', () => {
    render(<App />);
    expect(screen.getByText('NOCTURNE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新しい部屋をつくる/ })).toBeInTheDocument();
    expect(screen.getByLabelText('4桁のルームコード')).toBeInTheDocument();
  });

  it('provides an in-screen name field for saving card-count presets', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /新しい部屋をつくる/ }));
    fireEvent.click(screen.getByRole('button', { name: '詳しく編集' }));
    expect(screen.getByLabelText('保存する構成名')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '名前を付けて保存' })).toBeDisabled();
    expect(screen.getByLabelText('ジョーカーの枚数')).toHaveValue(1);
  });

  it('shows revealed opponent cards at a readable size with an explicit next action', () => {
    const onNext = vi.fn();
    render(<CardRevealModal event={{ id: 'reveal-1', text: '相手の手札は8。', revealTitle: '透視', reveal: [{ id: '8-x', rank: 8 }] }} onNext={onNext} />);
    expect(screen.getByRole('dialog', { name: '相手のカードを確認' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '8 交換' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('opens every discarded card and provides numeric sort orders', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /新しい部屋をつくる/ }));
    fireEvent.click(screen.getByRole('button', { name: /夜会を始める/ }));
    fireEvent.click(screen.getByRole('button', { name: /3枚見る/ }));
    fireEvent.click(screen.getByRole('button', { name: /墓地のカード1枚をすべて見る/ }));
    expect(screen.getByRole('dialog', { name: '墓地のカード' })).toBeInTheDocument();
    const sort = screen.getByLabelText('墓地の並び順');
    expect(sort).toHaveTextContent('数字の小さい順');
    expect(sort).toHaveTextContent('数字の大きい順');
    fireEvent.change(sort, { target: { value: 'rank-desc' } });
    expect(sort).toHaveValue('rank-desc');
  });

  it('dismisses the taunt even when the same event is resynchronized', () => {
    vi.useFakeTimers();
    const event = { id: 'taunt-1', text: '忘れてやーんの', kind: 'taunt' as const };
    const { rerender } = render(<TauntNotice event={event} />);
    expect(screen.getByText('忘れてやーんの')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(400));
    rerender(<TauntNotice event={{ ...event }} />);
    act(() => vi.advanceTimersByTime(200));
    rerender(<TauntNotice />);
    act(() => vi.advanceTimersByTime(300));

    expect(screen.queryByText('忘れてやーんの')).not.toBeInTheDocument();
  });

  it('keeps a normal draw motion visible long enough to follow without delaying play', () => {
    vi.useFakeTimers();
    const baseView: PlayerView = {
      id: 'game-1', version: 1,
      players: [{ id: 'player-1', name: '旅人', seat: 0, handCount: 1, ownHand: [{ id: 'old-card', rank: 4 }], eliminated: false, connected: true }],
      deckCount: 10, discard: [], rankOnePlayed: 0, reincarnationAvailable: true,
      turnPlayerId: 'player-1', turnNumber: 1, phase: 'draw', pendingEffect: null,
      pendingTargetCards: [], pendingTargetHandCount: 0, scholarCandidates: [], events: [], result: null,
    };
    const { rerender } = render(<GameMotionLayer view={baseView} playerId="player-1" />);
    rerender(<GameMotionLayer view={{
      ...baseView,
      version: 2,
      deckCount: 9,
      phase: 'action',
      players: [{ ...baseView.players[0], handCount: 2, ownHand: [...baseView.players[0].ownHand!, { id: 'drawn-card', rank: 7 }] }],
    }} playerId="player-1" />);

    expect(screen.getByText('手札に加わった')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(679));
    expect(screen.getByText('手札に加わった')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('手札に加わった')).not.toBeInTheDocument();
  });

  it('offers a reduced motion path for quick state feedback', () => {
    vi.useFakeTimers();
    const baseView: PlayerView = {
      id: 'game-1', version: 1,
      players: [{ id: 'player-1', name: '旅人', seat: 0, handCount: 1, ownHand: [{ id: 'old-card', rank: 4 }], eliminated: false, connected: true }],
      deckCount: 10, discard: [], rankOnePlayed: 0, reincarnationAvailable: true,
      turnPlayerId: 'player-1', turnNumber: 1, phase: 'draw', pendingEffect: null,
      pendingTargetCards: [], pendingTargetHandCount: 0, scholarCandidates: [], events: [], result: null,
    };
    const { rerender } = render(<GameMotionLayer view={baseView} playerId="player-1" mode="reduced" />);
    rerender(<GameMotionLayer view={{
      ...baseView,
      version: 2,
      deckCount: 9,
      phase: 'action',
      players: [{ ...baseView.players[0], handCount: 2, ownHand: [...baseView.players[0].ownHand!, { id: 'drawn-card', rank: 7 }] }],
    }} playerId="player-1" mode="reduced" />);

    expect(screen.getByText('手札に加わった')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(140));
    expect(screen.queryByText('手札に加わった')).not.toBeInTheDocument();
  });
});
