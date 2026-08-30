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

const counts = { 0: 1, ...Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, index < 8 ? 2 : 1])) };
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
const activeRevolution = playable.rank === 1 && drawn.view.rankOnePlayed >= 1;
const choices = playable.rank === 0
  ? { declaredRank: 4 }
  : targeted || activeRevolution ? { targetId: 'player-2', guess: 13 } : undefined;
const played = await invoke(host, {
  action: 'command', code: created.code, commandId: crypto.randomUUID(), expectedVersion: drawn.view.version,
  command: { type: 'play', cardId: playable.id, choices },
});
const guestAfterPlay = await invoke(guest, { action: 'snapshot', code: created.code });
if (guestAfterPlay.view.version !== played.view.version) throw new Error('Game state did not synchronize');
if (guestAfterPlay.view.players.find((player) => player.id === created.playerId)?.ownHand) {
  throw new Error('Another player hand was exposed');
}

const duelCounts = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, index === 5 ? 6 : 0]));
const duelRoom = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 2, counts: duelCounts });
const duelGuest = await invoke(guest, { action: 'join_room', name: 'GUEST', code: duelRoom.code });
const duelLobby = await invoke(host, { action: 'snapshot', code: duelRoom.code });
const duelStart = await invoke(host, {
  action: 'command', code: duelRoom.code, commandId: crypto.randomUUID(), expectedVersion: duelLobby.lobby.version,
  command: { type: 'start', counts: duelCounts, maxPlayers: 2 },
});
const hostDraw = await invoke(host, {
  action: 'command', code: duelRoom.code, commandId: crypto.randomUUID(), expectedVersion: duelStart.view.version,
  command: { type: 'draw', choice: 'one' },
});
const hostSix = hostDraw.view.players.find((player) => player.id === duelRoom.playerId)?.ownHand?.[0];
const firstSix = await invoke(host, {
  action: 'command', code: duelRoom.code, commandId: crypto.randomUUID(), expectedVersion: hostDraw.view.version,
  command: { type: 'play', cardId: hostSix.id, choices: { targetId: duelGuest.playerId } },
});
if (firstSix.view.players.some((player) => player.eliminated) || !firstSix.view.events.at(-1)?.text.startsWith('対面：')) {
  throw new Error('The first rank 6 did not resolve as a private face-to-face reveal');
}
const guestDuelView = await invoke(guest, { action: 'snapshot', code: duelRoom.code });
const guestDraw = await invoke(guest, {
  action: 'command', code: duelRoom.code, commandId: crypto.randomUUID(), expectedVersion: guestDuelView.view.version,
  command: { type: 'draw', choice: 'one' },
});
const guestSix = guestDraw.view.players.find((player) => player.id === duelGuest.playerId)?.ownHand?.[0];
const secondSix = await invoke(guest, {
  action: 'command', code: duelRoom.code, commandId: crypto.randomUUID(), expectedVersion: guestDraw.view.version,
  command: { type: 'play', cardId: guestSix.id, choices: { targetId: duelRoom.playerId } },
});
if (secondSix.view.players.some((player) => player.eliminated) || !secondSix.view.events.at(-1)?.text.startsWith('対決：')) {
  throw new Error('The second tied rank 6 did not continue without elimination');
}
const hostThirdView = await invoke(host, { action: 'snapshot', code: duelRoom.code });
const hostThirdDraw = await invoke(host, {
  action: 'command', code: duelRoom.code, commandId: crypto.randomUUID(), expectedVersion: hostThirdView.view.version,
  command: { type: 'draw', choice: 'one' },
});
const hostThirdSix = hostThirdDraw.view.players.find((player) => player.id === duelRoom.playerId)?.ownHand?.[0];
const thirdSix = await invoke(host, {
  action: 'command', code: duelRoom.code, commandId: crypto.randomUUID(), expectedVersion: hostThirdDraw.view.version,
  command: { type: 'play', cardId: hostThirdSix.id, choices: { targetId: duelGuest.playerId } },
});
if (thirdSix.view.players.some((player) => player.eliminated) || !thirdSix.view.events.filter((event) => event.reveal?.length).at(-1)?.text.startsWith('対決：')) {
  throw new Error('A rank 6 after the second did not resolve as a duel');
}

const revolutionCounts = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, index === 0 ? 10 : 0]));
const revolutionRoom = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 2, counts: revolutionCounts });
const revolutionGuest = await invoke(guest, { action: 'join_room', name: 'GUEST', code: revolutionRoom.code });
const revolutionLobby = await invoke(host, { action: 'snapshot', code: revolutionRoom.code });
const revolutionStart = await invoke(host, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: revolutionLobby.lobby.version,
  command: { type: 'start', counts: revolutionCounts, maxPlayers: 2 },
});
const revolutionHostDraw = await invoke(host, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: revolutionStart.view.version,
  command: { type: 'draw', choice: 'one' },
});
const revolutionHostCard = revolutionHostDraw.view.players.find((player) => player.id === revolutionRoom.playerId)?.ownHand?.[0];
const firstRevolution = await invoke(host, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: revolutionHostDraw.view.version,
  command: { type: 'play', cardId: revolutionHostCard.id },
});
if (firstRevolution.view.rankOnePlayed !== 1 || firstRevolution.view.pendingEffect) {
  throw new Error('The first rank 1 unexpectedly activated');
}
const revolutionGuestView = await invoke(guest, { action: 'snapshot', code: revolutionRoom.code });
const revolutionGuestDraw = await invoke(guest, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: revolutionGuestView.view.version,
  command: { type: 'draw', choice: 'one' },
});
const revolutionGuestCard = revolutionGuestDraw.view.players.find((player) => player.id === revolutionGuest.playerId)?.ownHand?.[0];
const secondRevolution = await invoke(guest, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: revolutionGuestDraw.view.version,
  command: { type: 'play', cardId: revolutionGuestCard.id, choices: { targetId: revolutionRoom.playerId } },
});
if (secondRevolution.view.rankOnePlayed !== 2 || secondRevolution.view.pendingEffect?.kind !== 'public-execution') {
  throw new Error('The second rank 1 did not activate public execution');
}
const secondResolved = await invoke(guest, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: secondRevolution.view.version,
  command: { type: 'resolve', discardIndex: 0 },
});
const thirdRevolutionDraw = await invoke(host, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: secondResolved.view.version,
  command: { type: 'draw', choice: 'one' },
});
const thirdRevolutionCard = thirdRevolutionDraw.view.players.find((player) => player.id === revolutionRoom.playerId)?.ownHand?.[0];
const thirdRevolution = await invoke(host, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: thirdRevolutionDraw.view.version,
  command: { type: 'play', cardId: thirdRevolutionCard.id, choices: { targetId: revolutionGuest.playerId } },
});
if (thirdRevolution.view.rankOnePlayed !== 3 || thirdRevolution.view.pendingEffect?.kind !== 'public-execution') {
  throw new Error('A rank 1 after the second did not activate public execution');
}

const jokerCounts = { 0: 6, ...Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, 0])) };
const jokerRoom = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 2, counts: jokerCounts });
await invoke(guest, { action: 'join_room', name: 'GUEST', code: jokerRoom.code });
const jokerLobby = await invoke(host, { action: 'snapshot', code: jokerRoom.code });
const jokerStart = await invoke(host, {
  action: 'command', code: jokerRoom.code, commandId: crypto.randomUUID(), expectedVersion: jokerLobby.lobby.version,
  command: { type: 'start', counts: jokerCounts, maxPlayers: 2 },
});
const jokerDraw = await invoke(host, {
  action: 'command', code: jokerRoom.code, commandId: crypto.randomUUID(), expectedVersion: jokerStart.view.version,
  command: { type: 'draw', choice: 'one' },
});
const jokerCard = jokerDraw.view.players.find((player) => player.id === jokerRoom.playerId)?.ownHand?.find((card) => card.rank === 0);
if (!jokerCard) throw new Error('The configured joker was not dealt');
const jokerPlayed = await invoke(host, {
  action: 'command', code: jokerRoom.code, commandId: crypto.randomUUID(), expectedVersion: jokerDraw.view.version,
  command: { type: 'play', cardId: jokerCard.id, choices: { declaredRank: 11 } },
});
if (!jokerPlayed.view.events.some((event) => event.text.includes('「ジョーカー」を11'))) {
  throw new Error('The joker declaration did not resolve online');
}

console.log(`Online smoke test passed (rooms ${created.code}/${duelRoom.code}/${revolutionRoom.code}/${jokerRoom.code}, version ${played.view.version})`);
