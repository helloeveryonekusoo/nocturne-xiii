import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import App from './App';

afterEach(cleanup);

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
});
