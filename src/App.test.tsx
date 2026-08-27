import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App, { CardRevealModal, TauntNotice } from './App';

afterEach(() => {
  cleanup();
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
});
