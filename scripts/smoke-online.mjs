import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required');

const makeClient = () => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function signIn(client) {
  const { error } = await client.auth.signInAnonymously();
  if (error) throw error;
}

async function invoke(client, body) {
  const { data, error } = await client.functions.invoke('game-api', { body });
  if (error) {
    const response = error.context;
    if (response) {
      try {
        const payload = await response.json();
        throw new Error(payload.error || error.message);
      } catch (cause) {
        if (cause instanceof Error && cause.message !== error.message) throw cause;
      }
    }
    throw error;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

const counts = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, index < 8 ? 2 : 1]));
const host = makeClient();
const guest = makeClient();
await Promise.all([signIn(host), signIn(guest)]);

const created = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 2, counts });
await invoke(guest, { action: 'join_room', name: 'GUEST', code: created.code });

const hostLobby = await invoke(host, { action: 'snapshot', code: created.code });
const guestLobby = await invoke(guest, { action: 'snapshot', code: created.code });
if (hostLobby.lobby.players.length !== 2 || guestLobby.lobby.players.length !== 2) {
  throw new Error('Lobby roster did not synchronize');
}
if (!hostLobby.lobby.isHost || guestLobby.lobby.isHost) throw new Error('Host permission is incorrect');

const configured = await invoke(host, {
  action: 'configure_room', code: created.code, maxPlayers: 2, counts,
});
const guestConfiguration = await invoke(guest, { action: 'snapshot', code: created.code });
if (guestConfiguration.lobby.version !== configured.lobby.version || guestConfiguration.lobby.maxPlayers !== 2) {
  throw new Error('Lobby configuration did not synchronize');
}

const started = await invoke(host, {
  action: 'command', code: created.code, commandId: crypto.randomUUID(), expectedVersion: configured.lobby.version,
  command: { type: 'start', counts, maxPlayers: 2 },
});
if (started.view.players.length !== 2 || started.view.turnPlayerId !== created.playerId) {
  throw new Error('Game did not start with both players');
}

const drawn = await invoke(host, {
  action: 'command', code: created.code, commandId: crypto.randomUUID(), expectedVersion: started.view.version,
  command: { type: 'draw', choice: 'one' },
});
const playable = drawn.view.players.find((player) => player.id === created.playerId)?.ownHand?.find((card) => card.rank !== 13);
if (!playable) throw new Error('No playable card after drawing');
const targeted = [2, 3, 5, 6, 8, 9].includes(playable.rank);
const secondRevolution = playable.rank === 1 && drawn.view.discard.filter((card) => card.rank === 1).length === 1;
const choices = targeted || secondRevolution ? { targetId: 'player-2', guess: 13 } : undefined;
const played = await invoke(host, {
  action: 'command', code: created.code, commandId: crypto.randomUUID(), expectedVersion: drawn.view.version,
  command: { type: 'play', cardId: playable.id, choices },
});
const guestAfterPlay = await invoke(guest, { action: 'snapshot', code: created.code });
if (guestAfterPlay.view.version !== played.view.version) throw new Error('Game state did not synchronize');
if (guestAfterPlay.view.players.find((player) => player.id === created.playerId)?.ownHand) {
  throw new Error('Another player hand was exposed');
}

console.log(`Online smoke test passed (room ${created.code}, version ${played.view.version})`);
