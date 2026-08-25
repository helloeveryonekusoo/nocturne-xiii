import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('Nocturne XIII interface', () => {
  it('renders the primary room actions and product identity', () => {
    render(<App />);
    expect(screen.getByText('NOCTURNE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新しい部屋をつくる/ })).toBeInTheDocument();
    expect(screen.getByLabelText('4桁のルームコード')).toBeInTheDocument();
  });
});
