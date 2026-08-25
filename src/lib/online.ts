import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { CardCounts } from './presets';
import type { PlayerView } from '../../supabase/functions/_shared/game';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const functionName = import.meta.env.VITE_GAME_FUNCTION_NAME || 'game-api';

export const onlineConfigured = Boolean(url && publishableKey);
export const supabase: SupabaseClient | null = onlineConfigured ? createClient(url!, publishableKey!, {
  auth: { persistSession: true, autoRefreshToken: true },
}) : null;

async function sessionClient() {
  if (!supabase) throw new Error('オンライン対戦の設定がまだ完了していません');
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  }
  return supabase;
}

async function invoke<T>(body: Record<string, unknown>) {
  const client = await sessionClient();
  const { data, error } = await client.functions.invoke(functionName, { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error as string);
  return data as T;
}

export const onlineApi = {
  createRoom: (name: string, maxPlayers: number, counts: CardCounts) =>
    invoke<{ code: string; playerId: string }>({ action: 'create_room', name, maxPlayers, counts }),
  joinRoom: (name: string, code: string) =>
    invoke<{ code: string; playerId: string }>({ action: 'join_room', name, code }),
  snapshot: (code: string) => invoke<{ view: PlayerView }>({ action: 'snapshot', code }),
  command: (code: string, commandId: string, expectedVersion: number, command: Record<string, unknown>) =>
    invoke<{ view: PlayerView }>({ action: 'command', code, commandId, expectedVersion, command }),
  subscribe(code: string, onChange: () => void): RealtimeChannel | null {
    if (!supabase) return null;
    const channel = supabase.channel(`room:${code}`, { config: { private: true } });
    channel.on('broadcast', { event: 'state_changed' }, onChange).subscribe();
    return channel;
  },
};
