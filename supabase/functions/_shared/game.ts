export type Phase = 'draw' | 'scholar-select' | 'action' | 'resolve' | 'ended';
export type Rng = () => number;

export interface Card {
  id: string;
  rank: number;
}

export interface PlayerState {
  id: string;
  name: string;
  seat: number;
  hand: Card[];
  eliminated: boolean;
  connected: boolean;
  guarded: boolean;
  pendingScholar: boolean;
}

export interface GameEvent {
  id: string;
  text: string;
  privateTo?: string;
  reveal?: Card[];
  revealTitle?: string;
  kind?: 'normal' | 'taunt' | 'system';
}

export interface PendingEffect {
  kind: 'masked-discard' | 'public-execution';
  actorId: string;
  targetId: string;
  blockReincarnation: boolean;
}

export interface GameResult {
  winners: string[];
  reason: 'last-survivor' | 'all-eliminated' | 'deck-exhausted';
  highRank?: number;
}

export interface GameState {
  id: string;
  version: number;
  players: PlayerState[];
  deck: Card[];
  discard: Card[];
  reincarnationCard: Card | null;
  turnIndex: number;
  turnNumber: number;
  phase: Phase;
  pendingEffect: PendingEffect | null;
  scholarCandidates: Card[];
  skipNextId: string | null;
  endAfterResolution: boolean;
  rankOnePlayed: number;
  rankSixPlayed: number;
  events: GameEvent[];
  result: GameResult | null;
}

export interface PlayChoices {
  targetId?: string;
  guess?: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  seat: number;
  handCount: number;
  ownHand?: Card[];
  eliminated: boolean;
  connected: boolean;
}

export interface PlayerView {
  id: string;
  version: number;
  players: PublicPlayer[];
  deckCount: number;
  discard: Card[];
  rankOnePlayed: number;
  reincarnationAvailable: boolean;
  turnPlayerId: string | null;
  turnNumber: number;
  phase: Phase;
  pendingEffect: PendingEffect | null;
  pendingTargetCards: Card[];
  pendingTargetHandCount: number;
  scholarCandidates: Card[];
  events: GameEvent[];
  result: GameResult | null;
}

const copy = <T>(value: T): T => structuredClone(value);
const eventId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function shuffle<T>(items: T[], rng: Rng = Math.random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(rng() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function log(state: GameState, text: string, options: Partial<GameEvent> = {}) {
  state.events.push({ id: eventId(), text, kind: 'normal', ...options });
  if (state.events.length > 80) state.events.splice(0, state.events.length - 80);
}

function activePlayer(state: GameState) {
  return state.players[state.turnIndex];
}

function requireTurn(state: GameState, playerId: string, phase?: Phase) {
  if (state.result) throw new Error('ゲームは終了しています');
  if (activePlayer(state)?.id !== playerId) throw new Error('あなたの手番ではありません');
  if (phase && state.phase !== phase) throw new Error('現在はその操作を行えません');
}

function recycleDiscard(state: GameState, rng: Rng) {
  if (!state.discard.length) return;
  state.deck = shuffle(state.discard, rng);
  state.discard = [];
  state.endAfterResolution = true;
  log(state, '墓地が混ざり、新しい山札になった。', { kind: 'system' });
}

function drawOne(state: GameState, source: 'normal' | 'effect', rng: Rng): Card | null {
  if (state.deck.length === 0) recycleDiscard(state, rng);
  const card = state.deck.pop() ?? null;
  if (!card) return null;
  if (state.deck.length === 0) {
    state.endAfterResolution = true;
    if (source === 'effect') recycleDiscard(state, rng);
  }
  return card;
}

function alivePlayers(state: GameState) {
  return state.players.filter((player) => !player.eliminated);
}

function nextAliveIndex(state: GameState, fromIndex: number) {
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const index = (fromIndex + offset) % state.players.length;
    if (!state.players[index].eliminated) return index;
  }
  return fromIndex;
}

function finishByRanks(state: GameState) {
  const alive = alivePlayers(state);
  if (!alive.length) {
    state.result = { winners: [], reason: 'all-eliminated' };
  } else {
    const highRank = Math.max(...alive.map((player) => player.hand[0]?.rank ?? 0));
    state.result = {
      winners: alive.filter((player) => (player.hand[0]?.rank ?? 0) === highRank).map((player) => player.id),
      reason: 'deck-exhausted',
      highRank,
    };
  }
  state.phase = 'ended';
  log(state, '山札切れ。全員が最後の手札を公開した。', { kind: 'system' });
}

function checkSurvivors(state: GameState) {
  const alive = alivePlayers(state);
  if (alive.length === 1) {
    state.result = { winners: [alive[0].id], reason: 'last-survivor' };
    state.phase = 'ended';
    return true;
  }
  if (alive.length === 0) {
    state.result = { winners: [], reason: 'all-eliminated' };
    state.phase = 'ended';
    return true;
  }
  return false;
}

function finishTurn(state: GameState) {
  state.pendingEffect = null;
  state.scholarCandidates = [];
  if (checkSurvivors(state)) return;
  if (state.endAfterResolution) {
    finishByRanks(state);
    return;
  }

  let nextIndex = nextAliveIndex(state, state.turnIndex);
  if (state.skipNextId && state.players[nextIndex].id === state.skipNextId) {
    log(state, `${state.players[nextIndex].name}の手番が飛ばされた。`);
    state.skipNextId = null;
    nextIndex = nextAliveIndex(state, nextIndex);
  }
  state.turnIndex = nextIndex;
  state.turnNumber += 1;
  state.phase = 'draw';
  state.players[nextIndex].guarded = false;
}

function reincarnate(state: GameState, player: PlayerState) {
  if (!state.reincarnationCard) return false;
  player.hand = [state.reincarnationCard];
  state.reincarnationCard = null;
  player.eliminated = false;
  log(state, `${player.name}は別の姿で戻ってきた。`);
  return true;
}

function eliminate(state: GameState, player: PlayerState, blockReincarnation = false) {
  const heldThirteen = player.hand.some((card) => card.rank === 13);
  state.discard.push(...player.hand);
  player.hand = [];
  if (heldThirteen && !blockReincarnation && reincarnate(state, player)) return;
  player.eliminated = true;
  player.guarded = false;
  player.pendingScholar = false;
  log(state, `${player.name}が卓を去った。`);
}

function targetPlayer(state: GameState, actorId: string, targetId?: string) {
  const target = state.players.find((player) => player.id === targetId && !player.eliminated);
  if (!target || target.id === actorId) throw new Error('有効な対象を選んでください');
  return target;
}

function blockedByGuard(state: GameState, target: PlayerState) {
  if (!target.guarded) return false;
  log(state, '何も起きなかった。');
  return true;
}

function prepareDiscardEffect(
  state: GameState,
  actor: PlayerState,
  target: PlayerState,
  kind: PendingEffect['kind'],
  blockReincarnation: boolean,
  rng: Rng,
) {
  const drawn = drawOne(state, 'effect', rng);
  if (drawn) target.hand.push(drawn);
  if (kind === 'masked-discard') target.hand = shuffle(target.hand, rng);
  state.pendingEffect = { kind, actorId: actor.id, targetId: target.id, blockReincarnation };
  state.phase = 'resolve';
  if (kind === 'public-execution') {
    log(state, `${target.name}の手札が公開された。`, { reveal: copy(target.hand), revealTitle: '公開処刑' });
  }
}

export function createGame(
  playerNames: string[],
  cardCounts: Record<number, number>,
  rng: Rng = Math.random,
): GameState {
  if (playerNames.length < 2 || playerNames.length > 5) throw new Error('プレイヤーは2〜5人です');
  const cards: Card[] = [];
  for (let rank = 1; rank <= 13; rank += 1) {
    const count = Math.max(0, Math.floor(cardCounts[rank] ?? 0));
    for (let index = 0; index < count; index += 1) cards.push({ id: `${rank}-${index}-${crypto.randomUUID()}`, rank });
  }
  if (cards.length < playerNames.length + 2) throw new Error('カードが足りません');
  const deck = shuffle(cards, rng);
  const players = playerNames.map((name, seat) => ({
    id: `player-${seat + 1}`,
    name,
    seat,
    hand: [deck.pop()!],
    eliminated: false,
    connected: true,
    guarded: false,
    pendingScholar: false,
  }));
  const reincarnationCard = deck.pop()!;
  const state: GameState = {
    id: crypto.randomUUID(), version: 1, players, deck, discard: [], reincarnationCard,
    turnIndex: 0, turnNumber: 1, phase: 'draw', pendingEffect: null,
    scholarCandidates: [], skipNextId: null, endAfterResolution: false, rankOnePlayed: 0, rankSixPlayed: 0, events: [], result: null,
  };
  log(state, '夜会が始まった。最初の一枚を引いてください。', { kind: 'system' });
  return state;
}

export function drawChoice(
  sourceState: GameState,
  playerId: string,
  choice: 'one' | 'three',
  rng: Rng = Math.random,
) {
  const state = copy(sourceState);
  requireTurn(state, playerId, 'draw');
  const actor = activePlayer(state);

  if (choice === 'three' && !actor.pendingScholar) {
    const drawn = drawOne(state, 'normal', rng);
    if (drawn) actor.hand.push(drawn);
    const discarded = actor.hand.splice(Math.floor(rng() * actor.hand.length), 1)[0];
    state.discard.push(discarded);
    log(state, `${actor.name}は禁じられた観測を試み、一枚を失った。`);
    if (discarded.rank === 13) {
      state.discard.push(...actor.hand);
      actor.hand = [];
      if (!reincarnate(state, actor)) actor.eliminated = true;
    }
    finishTurn(state);
    state.version += 1;
    return state;
  }

  if (choice === 'three') {
    actor.pendingScholar = false;
    state.scholarCandidates = [];
    for (let index = 0; index < 3; index += 1) {
      const card = drawOne(state, 'effect', rng);
      if (!card) break;
      state.scholarCandidates.push(card);
    }
    state.phase = 'scholar-select';
    log(state, `${actor.name}は三つの未来を見つめている。`);
  } else {
    const forgot = actor.pendingScholar;
    actor.pendingScholar = false;
    const card = drawOne(state, 'normal', rng);
    if (card) actor.hand.push(card);
    state.phase = 'action';
    if (forgot) log(state, '忘れてやーんの', { privateTo: actor.id, kind: 'taunt' });
  }
  state.version += 1;
  return state;
}

export function selectScholarCard(
  sourceState: GameState,
  playerId: string,
  cardId: string,
  rng: Rng = Math.random,
) {
  const state = copy(sourceState);
  requireTurn(state, playerId, 'scholar-select');
  const selected = state.scholarCandidates.find((card) => card.id === cardId);
  if (!selected) throw new Error('選択できないカードです');
  activePlayer(state).hand.push(selected);
  state.deck.push(...state.scholarCandidates.filter((card) => card.id !== cardId));
  state.deck = shuffle(state.deck, rng);
  state.scholarCandidates = [];
  state.phase = 'action';
  state.version += 1;
  return state;
}

export function resolvePendingEffect(
  sourceState: GameState,
  playerId: string,
  discardIndex: number,
) {
  const state = copy(sourceState);
  requireTurn(state, playerId, 'resolve');
  const pending = state.pendingEffect;
  if (!pending || pending.actorId !== playerId) throw new Error('解決待ちの効果がありません');
  const target = state.players.find((player) => player.id === pending.targetId)!;
  const safeIndex = Math.max(0, Math.min(discardIndex, target.hand.length - 1));
  const discarded = target.hand.splice(safeIndex, 1)[0];
  if (discarded) state.discard.push(discarded);

  if (discarded?.rank === 13) {
    state.discard.push(...target.hand);
    target.hand = [];
    if (pending.blockReincarnation || !reincarnate(state, target)) {
      target.eliminated = true;
      log(state, `${target.name}が卓を去った。`);
    }
  }
  state.pendingEffect = null;
  finishTurn(state);
  state.version += 1;
  return state;
}

export function playCard(
  sourceState: GameState,
  playerId: string,
  cardId: string,
  choices: PlayChoices = {},
  rng: Rng = Math.random,
) {
  const state = copy(sourceState);
  requireTurn(state, playerId, 'action');
  const actor = activePlayer(state);
  const cardIndex = actor.hand.findIndex((card) => card.id === cardId);
  if (cardIndex < 0) throw new Error('そのカードは手札にありません');
  const card = actor.hand[cardIndex];
  if (card.rank === 13) throw new Error('13は自分から場に出せません');
  actor.hand.splice(cardIndex, 1);
  state.discard.push(card);
  log(state, `${actor.name}が「${CARD_NAMES[card.rank]}」を使った。`);

  const guardedTarget = () => {
    const target = targetPlayer(state, actor.id, choices.targetId);
    return blockedByGuard(state, target) ? null : target;
  };

  switch (card.rank) {
    case 1: {
      const previousOneCount = state.rankOnePlayed ?? Math.max(0, state.discard.filter((item) => item.rank === 1).length - 1);
      state.rankOnePlayed = previousOneCount + 1;
      if (state.rankOnePlayed >= 2) {
        const target = guardedTarget();
        if (target) prepareDiscardEffect(state, actor, target, 'public-execution', false, rng);
        else finishTurn(state);
      } else finishTurn(state);
      break;
    }
    case 2: {
      const target = guardedTarget();
      if (target && target.hand[0]?.rank === choices.guess) eliminate(state, target);
      else if (target) log(state, '宣言は外れた。');
      finishTurn(state);
      break;
    }
    case 3: {
      const target = guardedTarget();
      if (target) log(state, `${target.name}の手札は${target.hand[0]?.rank ?? 'なし'}。`, { privateTo: actor.id, reveal: copy(target.hand), revealTitle: '透視' });
      finishTurn(state);
      break;
    }
    case 4:
      actor.guarded = true;
      finishTurn(state);
      break;
    case 5: {
      const target = guardedTarget();
      if (target) prepareDiscardEffect(state, actor, target, 'masked-discard', false, rng);
      else finishTurn(state);
      break;
    }
    case 6: {
      const target = guardedTarget();
      if (target) {
        const ownRank = actor.hand[0]?.rank ?? 0;
        const targetRank = target.hand[0]?.rank ?? 0;
        const ownHand = copy(actor.hand);
        const targetHand = copy(target.hand);
        const previousSixCount = state.rankSixPlayed ?? Math.max(0, state.discard.filter((item) => item.rank === 6).length - 1);
        state.rankSixPlayed = previousSixCount + 1;
        const isDuel = state.rankSixPlayed >= 2;
        if (isDuel) {
          if (ownRank < targetRank) eliminate(state, actor);
          else if (targetRank < ownRank) eliminate(state, target);
          else log(state, '対決は引き分け。勝負はそのまま続く。');
        }
        const mode = isDuel ? '対決' : '対面';
        log(state, `${mode}：${target.name}の手札は${targetRank}。`, { privateTo: actor.id, reveal: targetHand, revealTitle: mode });
        log(state, `${mode}：${actor.name}の手札は${ownRank}。`, { privateTo: target.id, reveal: ownHand, revealTitle: mode });
      }
      finishTurn(state);
      break;
    }
    case 7:
      actor.pendingScholar = true;
      finishTurn(state);
      break;
    case 8: {
      const target = guardedTarget();
      if (target) [actor.hand, target.hand] = [target.hand, actor.hand];
      finishTurn(state);
      break;
    }
    case 9: {
      const target = guardedTarget();
      if (target) prepareDiscardEffect(state, actor, target, 'public-execution', true, rng);
      else finishTurn(state);
      break;
    }
    case 10: {
      const remaining = [...actor.hand];
      actor.hand = [];
      state.discard.push(...remaining);
      const hadThirteen = remaining.some((item) => item.rank === 13);
      if (!(hadThirteen && reincarnate(state, actor))) {
        const drawn = drawOne(state, 'effect', rng);
        if (drawn) actor.hand = [drawn];
      }
      finishTurn(state);
      break;
    }
    case 11: {
      const nextIndex = nextAliveIndex(state, state.turnIndex);
      state.skipNextId = state.players[nextIndex].id;
      finishTurn(state);
      break;
    }
    case 12: {
      for (let offset = 1; offset < state.players.length; offset += 1) {
        const target = state.players[(state.turnIndex + offset) % state.players.length];
        if (target.eliminated || target.id === actor.id) continue;
        if (blockedByGuard(state, target)) continue;
        const oldHand = [...target.hand];
        target.hand = [];
        state.discard.push(...oldHand);
        const hadThirteen = oldHand.some((item) => item.rank === 13);
        if (hadThirteen) {
          if (!reincarnate(state, target)) target.eliminated = true;
        } else {
          const drawn = drawOne(state, 'effect', rng);
          if (drawn) target.hand = [drawn];
        }
      }
      finishTurn(state);
      break;
    }
    default:
      finishTurn(state);
  }
  state.version += 1;
  return state;
}

export function projectForPlayer(state: GameState, viewerId: string): PlayerView {
  const visiblePending = state.pendingEffect?.actorId === viewerId ? state.pendingEffect : null;
  const pendingTarget = visiblePending
    ? state.players.find((player) => player.id === visiblePending.targetId)
    : undefined;
  return {
    id: state.id,
    version: state.version,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      seat: player.seat,
      handCount: player.hand.length,
      ownHand: player.id === viewerId || state.result ? copy(player.hand) : undefined,
      eliminated: player.eliminated,
      connected: player.connected,
    })),
    deckCount: state.deck.length,
    discard: copy(state.discard),
    rankOnePlayed: state.rankOnePlayed ?? state.discard.filter((item) => item.rank === 1).length,
    reincarnationAvailable: Boolean(state.reincarnationCard),
    turnPlayerId: state.result ? null : activePlayer(state)?.id ?? null,
    turnNumber: state.turnNumber,
    phase: state.phase,
    pendingEffect: visiblePending ? copy(visiblePending) : null,
    pendingTargetCards: visiblePending?.kind === 'public-execution' && pendingTarget
      ? copy(pendingTarget.hand)
      : [],
    pendingTargetHandCount: pendingTarget?.hand.length ?? 0,
    scholarCandidates: activePlayer(state)?.id === viewerId ? copy(state.scholarCandidates) : [],
    events: state.events.filter((item) => !item.privateTo || item.privateTo === viewerId).map((item) => copy(item)),
    result: copy(state.result),
  };
}

export const CARD_NAMES: Record<number, string> = {
  1: '革命', 2: '捜査', 3: '透視', 4: '静寂', 5: '疫病', 6: '対面・対決', 7: '選択',
  8: '交換', 9: '公開処刑', 10: '強制転生', 11: '跳躍', 12: '全体転生', 13: '潜伏・転生',
};

export const CARD_DESCRIPTIONS: Record<number, string> = {
  1: '二枚目以降は公開処刑へ変わる。',
  2: '相手の階位を言い当てる。',
  3: 'ひとりの手札を自分だけが見る。',
  4: '次の実際の手番まで効果を受けない。',
  5: '相手に一枚引かせ、見ずに一枚を捨てる。',
  6: '一枚目は密かに手札を見せ合う。二枚目以降は対決し、小さい方が脱落。同値なら続行。',
  7: '次の自分の手番で三枚から一枚を選べる。',
  8: 'ひとりと手札を交換する。',
  9: '相手の二枚を公開し、一枚を処刑する。',
  10: '手札をすべて捨て、新しい一枚を引く。',
  11: '次のプレイヤーの手番を飛ばす。',
  12: '自分以外の手札を順に生まれ変わらせる。',
  13: '自分から出せず、捨てられると転生する。',
};
