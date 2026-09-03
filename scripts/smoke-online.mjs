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
const joined = await invoke(guest, { action: 'join_room', name: 'GUEST', code: created.code });
const pair = [
  { client: host, playerId: created.playerId },
  { client: guest, playerId: joined.playerId },
];
const participant = (players, playerId) => players.find((player) => player.playerId === playerId);

async function playOnlyCardTurn(code, sourceView, players, rank, choicesFor) {
  const actor = participant(players, sourceView.turnPlayerId);
  if (!actor) throw new Error('Turn player was not found');
  const actorSnapshot = await invoke(actor.client, { action: 'snapshot', code });
  const drawn = await invoke(actor.client, {
    action: 'command', code, commandId: crypto.randomUUID(), expectedVersion: actorSnapshot.view.version,
    command: { type: 'draw', choice: 'one' },
  });
  const ownCard = drawn.view.players.find((player) => player.id === actor.playerId)?.ownHand?.find((card) => card.rank === rank);
  if (!ownCard) throw new Error(`Rank ${rank} was not available to the turn player`);
  const target = players.find((player) => player.playerId !== actor.playerId);
  return invoke(actor.client, {
    action: 'command', code, commandId: crypto.randomUUID(), expectedVersion: drawn.view.version,
    command: { type: 'play', cardId: ownCard.id, choices: choicesFor?.(drawn.view, target?.playerId) },
  });
}

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
if (started.view.players.length !== 2 || !pair.some((player) => player.playerId === started.view.turnPlayerId)) {
  throw new Error('Game did not start with both players');
}

const firstActor = participant(pair, started.view.turnPlayerId);
const firstObserver = pair.find((player) => player.playerId !== firstActor.playerId);
const drawn = await invoke(firstActor.client, {
  action: 'command', code: created.code, commandId: crypto.randomUUID(), expectedVersion: started.view.version,
  command: { type: 'draw', choice: 'one' },
});
const playable = drawn.view.players.find((player) => player.id === firstActor.playerId)?.ownHand?.find((card) => card.rank !== 13);
if (!playable) throw new Error('No playable card after drawing');
const targeted = [2, 3, 5, 6, 8, 9].includes(playable.rank);
const activeRevolution = playable.rank === 1 && drawn.view.rankOnePlayed >= 1;
const choices = playable.rank === 0
  ? { declaredRank: 4 }
  : targeted || activeRevolution ? { targetId: firstObserver.playerId, guess: 13 } : undefined;
const played = await invoke(firstActor.client, {
  action: 'command', code: created.code, commandId: crypto.randomUUID(), expectedVersion: drawn.view.version,
  command: { type: 'play', cardId: playable.id, choices },
});
const observerAfterPlay = await invoke(firstObserver.client, { action: 'snapshot', code: created.code });
if (observerAfterPlay.view.version !== played.view.version) throw new Error('Game state did not synchronize');
if (observerAfterPlay.view.players.find((player) => player.id === firstActor.playerId)?.ownHand) {
  throw new Error('Another player hand was exposed');
}

const duelCounts = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, index === 5 ? 6 : 0]));
const duelRoom = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 2, counts: duelCounts });
const duelGuest = await invoke(guest, { action: 'join_room', name: 'GUEST', code: duelRoom.code });
const duelPair = [{ client: host, playerId: duelRoom.playerId }, { client: guest, playerId: duelGuest.playerId }];
const duelLobby = await invoke(host, { action: 'snapshot', code: duelRoom.code });
const duelStart = await invoke(host, {
  action: 'command', code: duelRoom.code, commandId: crypto.randomUUID(), expectedVersion: duelLobby.lobby.version,
  command: { type: 'start', counts: duelCounts, maxPlayers: 2 },
});
const firstSix = await playOnlyCardTurn(duelRoom.code, duelStart.view, duelPair, 6, (_view, targetId) => ({ targetId }));
if (firstSix.view.players.some((player) => player.eliminated) || !firstSix.view.events.at(-1)?.text.startsWith('対面：')) {
  throw new Error('The first rank 6 did not resolve as a private face-to-face reveal');
}
const secondSix = await playOnlyCardTurn(duelRoom.code, firstSix.view, duelPair, 6, (_view, targetId) => ({ targetId }));
if (secondSix.view.players.some((player) => player.eliminated) || !secondSix.view.events.at(-1)?.text.startsWith('対決：')) {
  throw new Error('The second tied rank 6 did not continue without elimination');
}
const thirdSix = await playOnlyCardTurn(duelRoom.code, secondSix.view, duelPair, 6, (_view, targetId) => ({ targetId }));
if (thirdSix.view.players.some((player) => player.eliminated) || !thirdSix.view.events.filter((event) => event.reveal?.length).at(-1)?.text.startsWith('対決：')) {
  throw new Error('A rank 6 after the second did not resolve as a duel');
}

const revolutionCounts = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, index === 0 ? 10 : 0]));
const revolutionRoom = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 2, counts: revolutionCounts });
const revolutionGuest = await invoke(guest, { action: 'join_room', name: 'GUEST', code: revolutionRoom.code });
const revolutionPair = [{ client: host, playerId: revolutionRoom.playerId }, { client: guest, playerId: revolutionGuest.playerId }];
const revolutionLobby = await invoke(host, { action: 'snapshot', code: revolutionRoom.code });
const revolutionStart = await invoke(host, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: revolutionLobby.lobby.version,
  command: { type: 'start', counts: revolutionCounts, maxPlayers: 2 },
});
const firstRevolution = await playOnlyCardTurn(revolutionRoom.code, revolutionStart.view, revolutionPair, 1, () => undefined);
if (firstRevolution.view.rankOnePlayed !== 1 || firstRevolution.view.pendingEffect) {
  throw new Error('The first rank 1 unexpectedly activated');
}
const secondRevolution = await playOnlyCardTurn(revolutionRoom.code, firstRevolution.view, revolutionPair, 1, (_view, targetId) => ({ targetId }));
if (secondRevolution.view.rankOnePlayed !== 2 || secondRevolution.view.pendingEffect?.kind !== 'public-execution') {
  throw new Error('The second rank 1 did not activate public execution');
}
const revolutionActor = participant(revolutionPair, secondRevolution.view.pendingEffect.actorId);
const revolutionObserver = revolutionPair.find((player) => player.playerId !== revolutionActor.playerId);
const revolutionObserverView = await invoke(revolutionObserver.client, { action: 'snapshot', code: revolutionRoom.code });
if (revolutionObserverView.view.events.some((event) => event.revealTitle === '公開処刑')) {
  throw new Error('A rank 1 public-execution hand leaked to the other player');
}
const secondResolved = await invoke(revolutionActor.client, {
  action: 'command', code: revolutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: secondRevolution.view.version,
  command: { type: 'resolve', discardIndex: 0 },
});
const thirdRevolution = await playOnlyCardTurn(revolutionRoom.code, secondResolved.view, revolutionPair, 1, (_view, targetId) => ({ targetId }));
if (thirdRevolution.view.rankOnePlayed !== 3 || thirdRevolution.view.pendingEffect?.kind !== 'public-execution') {
  throw new Error('A rank 1 after the second did not activate public execution');
}

const jokerCounts = { 0: 6, ...Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, 0])) };
const jokerRoom = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 2, counts: jokerCounts });
const jokerGuest = await invoke(guest, { action: 'join_room', name: 'GUEST', code: jokerRoom.code });
const jokerPair = [{ client: host, playerId: jokerRoom.playerId }, { client: guest, playerId: jokerGuest.playerId }];
const jokerLobby = await invoke(host, { action: 'snapshot', code: jokerRoom.code });
const jokerStart = await invoke(host, {
  action: 'command', code: jokerRoom.code, commandId: crypto.randomUUID(), expectedVersion: jokerLobby.lobby.version,
  command: { type: 'start', counts: jokerCounts, maxPlayers: 2 },
});
const jokerPlayed = await playOnlyCardTurn(jokerRoom.code, jokerStart.view, jokerPair, 0, () => ({ declaredRank: 11 }));
if (!jokerPlayed.view.events.some((event) => event.text.includes('「ジョーカー」を11'))) {
  throw new Error('The joker declaration did not resolve online');
}

const privateExecutionCounts = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 1, index === 8 ? 6 : 0]));
const privateExecutionRoom = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 2, counts: privateExecutionCounts });
const privateExecutionGuest = await invoke(guest, { action: 'join_room', name: 'GUEST', code: privateExecutionRoom.code });
const privateExecutionPair = [
  { client: host, playerId: privateExecutionRoom.playerId },
  { client: guest, playerId: privateExecutionGuest.playerId },
];
const privateExecutionLobby = await invoke(host, { action: 'snapshot', code: privateExecutionRoom.code });
const privateExecutionStart = await invoke(host, {
  action: 'command', code: privateExecutionRoom.code, commandId: crypto.randomUUID(), expectedVersion: privateExecutionLobby.lobby.version,
  command: { type: 'start', counts: privateExecutionCounts, maxPlayers: 2 },
});
const privateExecution = await playOnlyCardTurn(
  privateExecutionRoom.code,
  privateExecutionStart.view,
  privateExecutionPair,
  9,
  (_view, targetId) => ({ targetId }),
);
const privateExecutionActor = participant(privateExecutionPair, privateExecution.view.pendingEffect?.actorId);
const privateExecutionObserver = privateExecutionPair.find((player) => player.playerId !== privateExecutionActor.playerId);
const privateExecutionObserverView = await invoke(privateExecutionObserver.client, { action: 'snapshot', code: privateExecutionRoom.code });
if (!privateExecution.view.events.some((event) => event.revealTitle === '公開処刑')
  || privateExecutionObserverView.view.events.some((event) => event.revealTitle === '公開処刑')) {
  throw new Error('A rank 9 public-execution hand was not private to its user');
}

const concurrentGuests = [guest, makeClient(), makeClient(), makeClient()];
await Promise.all(concurrentGuests.slice(1).map(signIn));
const raceCodes = [];
for (let round = 0; round < 3; round += 1) {
  const raceRoom = await invoke(host, { action: 'create_room', name: 'HOST', maxPlayers: 5, counts });
  raceCodes.push(raceRoom.code);
  const joins = await Promise.all(concurrentGuests.map((client, index) => invoke(client, {
    action: 'join_room', name: `GUEST${index + 1}`, code: raceRoom.code,
  })));
  const raceLobby = await invoke(host, { action: 'snapshot', code: raceRoom.code });
  if (raceLobby.lobby.players.length !== 5 || new Set(joins.map((join) => join.playerId)).size !== 4) {
    throw new Error('Concurrent room joins did not allocate unique seats');
  }
}

console.log(`Online smoke test passed (rooms ${created.code}/${duelRoom.code}/${revolutionRoom.code}/${jokerRoom.code}/${privateExecutionRoom.code}; concurrent ${raceCodes.join('/')}, version ${played.view.version})`);
