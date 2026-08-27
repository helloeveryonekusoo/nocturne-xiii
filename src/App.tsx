import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CARD_DESCRIPTIONS, CARD_NAMES, createGame, drawChoice, playCard, projectForPlayer,
  resolvePendingEffect, selectScholarCard, type Card, type GameEvent, type GameState, type PlayerView,
} from '../supabase/functions/_shared/game';
import {
  exportPreset, readPresets, STARTER_COUNTS, validateCounts, writePresets,
  type CardCounts, type SavedPreset,
} from './lib/presets';
import { onlineApi, onlineConfigured, type LobbySnapshot, type RoomSnapshot } from './lib/online';

type Screen = 'home' | 'lobby' | 'game';
const PLAYER_ID = 'player-1';
const SIGILS: Record<number, string> = {
  1: 'Ⅰ', 2: '⌖', 3: '◉', 4: '◇', 5: '✣', 6: '⚔', 7: '△',
  8: '∞', 9: '♛', 10: '↻', 11: '»', 12: '✦', 13: '☼',
};

const id = () => crypto.randomUUID();
const savedName = () => {
  try { return globalThis.localStorage?.getItem('nocturne-name') || '旅人'; }
  catch { return '旅人'; }
};

function CardArtwork({ card, compact = false }: { card: Card; compact?: boolean }) {
  return (
    <>
      <span className="card-rank">{card.rank}</span>
      <span className="card-sigil" aria-hidden="true">{SIGILS[card.rank]}</span>
      <span className="card-title">{CARD_NAMES[card.rank]}</span>
      {!compact && <span className="card-copy">{CARD_DESCRIPTIONS[card.rank]}</span>}
    </>
  );
}

function CardFace({ card, onClick, disabled, compact = false }: {
  card: Card; onClick?: () => void; disabled?: boolean; compact?: boolean;
}) {
  return (
    <button
      className={`card-face rank-${card.rank} ${compact ? 'compact-card' : ''}`}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${card.rank} ${CARD_NAMES[card.rank]}`}
    >
      <CardArtwork card={card} compact={compact} />
    </button>
  );
}

export function CardRevealModal({ event, onNext }: { event: GameEvent; onNext: () => void }) {
  return (
    <div className="modal-backdrop reveal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reveal-title">
      <div className="choice-modal reveal-modal">
        <small>{event.revealTitle ?? 'CARD REVEAL'}</small>
        <h3 id="reveal-title">相手のカードを確認</h3>
        <p>{event.text}</p>
        <div className="reveal-cards">{event.reveal?.map((card) => <div className="card-face reveal-card" role="img" aria-label={`${card.rank} ${CARD_NAMES[card.rank]}`} key={card.id}><CardArtwork card={card} /></div>)}</div>
        <button className="primary-button reveal-next" type="button" onClick={onNext}>次へ <span>→</span></button>
      </div>
    </div>
  );
}

function Brand({ onHome }: { onHome: () => void }) {
  return (
    <button className="brand" type="button" onClick={onHome} aria-label="タイトルへ戻る">
      <span className="brand-mark">XIII</span><span>NOCTURNE</span>
    </button>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [name, setName] = useState(savedName);
  const [joinCode, setJoinCode] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(5);
  const [counts, setCounts] = useState<CardCounts>({ ...STARTER_COUNTS });
  const [presets, setPresets] = useState<SavedPreset[]>(readPresets);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [presetName, setPresetName] = useState('');
  const [game, setGame] = useState<GameState | null>(null);
  const [onlineView, setOnlineView] = useState<PlayerView | null>(null);
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [playerId, setPlayerId] = useState(PLAYER_ID);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [targeting, setTargeting] = useState<Card | null>(null);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [guess, setGuess] = useState(13);
  const [toast, setToast] = useState('');
  const [taunt, setTaunt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [graveOpen, setGraveOpen] = useState(false);
  const [graveSort, setGraveSort] = useState<'played' | 'rank-asc' | 'rank-desc'>('played');
  const [dismissedRevealId, setDismissedRevealId] = useState<string | null>(null);
  const lastTaunt = useRef<string | null>(null);
  const editingCounts = useRef(false);

  const previewPlayers = useMemo(() => [name || '旅人', 'KIRI', 'AO'].slice(0, Math.min(maxPlayers, 3)), [name, maxPlayers]);
  const players = onlineConfigured && lobby
    ? lobby.players.map((player) => player.displayName)
    : previewPlayers;
  const view = useMemo(() => onlineConfigured ? onlineView : game ? projectForPlayer(game, PLAYER_ID) : null, [game, onlineView]);
  const me = view?.players.find((player) => player.id === playerId);
  const isMyTurn = view?.turnPlayerId === playerId;
  const latestEvent = view?.events.at(-1);
  const latestRevealEvent = view?.events.filter((event) => event.reveal?.length).at(-1);
  const visibleRevealEvent = latestRevealEvent?.id !== dismissedRevealId
    && !(isMyTurn && view?.phase === 'resolve' && view.pendingEffect)
    ? latestRevealEvent
    : null;
  const visibleDiscard = useMemo(() => {
    const cards = [...(view?.discard ?? [])];
    if (graveSort === 'rank-asc') cards.sort((left, right) => left.rank - right.rank);
    if (graveSort === 'rank-desc') cards.sort((left, right) => right.rank - left.rank);
    return cards;
  }, [graveSort, view?.discard]);

  const acceptSnapshot = useCallback((snapshot: RoomSnapshot) => {
    if (snapshot.lobby) {
      setLobby(snapshot.lobby);
      setMaxPlayers(snapshot.lobby.maxPlayers);
      if (!editingCounts.current) setCounts({ ...snapshot.lobby.counts });
      setOnlineView(null);
      setScreen('lobby');
    } else if (snapshot.view) {
      setOnlineView(snapshot.view);
      setScreen('game');
    }
  }, []);

  useEffect(() => {
    if (latestEvent?.kind === 'taunt' && latestEvent.id !== lastTaunt.current) {
      lastTaunt.current = latestEvent.id;
      setTaunt(true);
      const timer = window.setTimeout(() => setTaunt(false), 900);
      return () => window.clearTimeout(timer);
    }
  }, [latestEvent]);

  useEffect(() => {
    if (!onlineConfigured || !roomCode || screen === 'home') return;
    let active = true;
    let channel: Awaited<ReturnType<typeof onlineApi.subscribe>> = null;
    const refresh = async () => {
      try {
        const snapshot = await onlineApi.snapshot(roomCode);
        if (active) acceptSnapshot(snapshot);
      } catch { /* the next realtime event or poll retries */ }
    };
    void refresh();
    void onlineApi.subscribe(roomCode, refresh).then((nextChannel) => {
      if (!active) void onlineApi.unsubscribe(nextChannel);
      else channel = nextChannel;
    }).catch(() => { /* polling remains active */ });
    const timer = window.setInterval(refresh, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
      void onlineApi.unsubscribe(channel);
    };
  }, [acceptSnapshot, roomCode, screen]);

  useEffect(() => {
    if (onlineConfigured || !game || game.result || game.players[game.turnIndex]?.id === PLAYER_ID) return;
    const timer = window.setTimeout(() => {
      try {
        const bot = game.players[game.turnIndex];
        let next = game;
        if (game.phase === 'draw') {
          next = drawChoice(game, bot.id, bot.pendingScholar ? 'three' : 'one');
        } else if (game.phase === 'scholar-select') {
          next = selectScholarCard(game, bot.id, game.scholarCandidates[0].id);
        } else if (game.phase === 'resolve') {
          const target = game.players.find((player) => player.id === game.pendingEffect?.targetId);
          const index = game.pendingEffect?.kind === 'public-execution'
            ? Math.max(0, (target?.hand ?? []).reduce((best, card, index, hand) => card.rank > hand[best].rank ? index : best, 0))
            : Math.floor(Math.random() * Math.max(1, target?.hand.length ?? 1));
          next = resolvePendingEffect(game, bot.id, index);
        } else if (game.phase === 'action') {
          const playable = bot.hand.filter((card) => card.rank !== 13);
          const card = playable[Math.floor(Math.random() * playable.length)];
          if (!card) return;
          const targets = game.players.filter((player) => !player.eliminated && player.id !== bot.id);
          const target = targets[Math.floor(Math.random() * targets.length)];
          next = playCard(game, bot.id, card.id, { targetId: target?.id, guess: 1 + Math.floor(Math.random() * 13) });
        }
        setGame(next);
      } catch (error) {
        setToast(error instanceof Error ? error.message : '自動手番で問題が起きました');
      }
    }, 720);
    return () => window.clearTimeout(timer);
  }, [game]);

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2400);
  };

  const sendOnlineCommand = async (command: Record<string, unknown>) => {
    if (!onlineView || !roomCode) throw new Error('盤面を同期できていません');
    setBusy(true);
    try {
      const result = await onlineApi.command(roomCode, id(), onlineView.version, command);
      setOnlineView(result.view);
      setScreen('game');
    } catch (error) {
      try { acceptSnapshot(await onlineApi.snapshot(roomCode)); } catch { /* keep the actionable error */ }
      flash(error instanceof Error ? error.message : '操作を反映できませんでした');
    } finally {
      setBusy(false);
    }
  };

  const configureOnlineRoom = async (nextMaxPlayers = maxPlayers, nextCounts = counts) => {
    if (!onlineConfigured || !lobby?.isHost) return;
    setBusy(true);
    try {
      const result = await onlineApi.configureRoom(roomCode, nextMaxPlayers, nextCounts);
      acceptSnapshot(result);
    } catch (error) {
      flash(error instanceof Error ? error.message : '構成を更新できませんでした');
    } finally {
      setBusy(false);
    }
  };

  const enterLobby = async (mode: 'create' | 'join') => {
    const cleanName = name.trim();
    if (!cleanName) return flash('呼び名を入力してください');
    if (mode === 'join' && joinCode.length !== 4) return flash('4桁の合言葉を入力してください');
    setBusy(true);
    try { globalThis.localStorage?.setItem('nocturne-name', cleanName); } catch { /* private browsing */ }
    try {
      if (onlineConfigured) {
        const result = mode === 'create'
          ? await onlineApi.createRoom(cleanName, maxPlayers, counts)
          : await onlineApi.joinRoom(cleanName, joinCode);
        setRoomCode(result.code);
        setPlayerId(result.playerId);
        acceptSnapshot(await onlineApi.snapshot(result.code));
      } else {
        setRoomCode(mode === 'join' ? joinCode : String(Math.floor(1000 + Math.random() * 9000)));
        setPlayerId(PLAYER_ID);
        setScreen('lobby');
      }
    } catch (error) {
      flash(error instanceof Error ? error.message : 'ルームへ接続できませんでした');
    } finally {
      setBusy(false);
    }
  };

  const startGame = async () => {
    const error = validateCounts(counts, players.length);
    if (error) return flash(error);
    if (onlineConfigured) {
      if (!lobby?.isHost) return flash('ホストの開始を待ってください');
      if (players.length < 2) return flash('2人以上揃うと開始できます');
      setBusy(true);
      try {
        const result = await onlineApi.command(roomCode, id(), lobby.version, {
          type: 'start', counts, maxPlayers,
        });
        setOnlineView(result.view);
        setScreen('game');
        setSettingsOpen(false);
      } catch (cause) {
        flash(cause instanceof Error ? cause.message : 'ゲームを開始できませんでした');
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      setGame(createGame(players, counts));
      setScreen('game');
      setSettingsOpen(false);
    } catch (cause) {
      flash(cause instanceof Error ? cause.message : 'ゲームを開始できませんでした');
    }
  };

  const savePreset = () => {
    const cleanName = presetName.trim();
    if (!cleanName) return flash('保存する構成名を入力してください');
    const next = [...presets, { id: id(), name: cleanName, counts: { ...counts } }];
    setPresets(next); writePresets(next); setSelectedPreset(next.at(-1)!.id);
    setPresetName('');
    flash('構成を保存しました');
  };

  const updateCount = (rank: number, delta: number) => {
    setCounts((current) => ({ ...current, [rank]: Math.max(0, Math.min(20, (current[rank] ?? 0) + delta)) }));
  };

  const openSettings = () => {
    editingCounts.current = true;
    setPresetName('');
    setSettingsOpen(true);
  };

  const closeSettings = () => {
    editingCounts.current = false;
    setSettingsOpen(false);
    if (onlineConfigured && lobby) setCounts({ ...lobby.counts });
  };

  const applySettings = async () => {
    setSettingsOpen(false);
    try {
      await configureOnlineRoom();
    } finally {
      editingCounts.current = false;
    }
  };

  const chooseCard = (card: Card) => {
    if (!view || !isMyTurn || view.phase !== 'action' || busy) return;
    if (card.rank === 13) return flash('13は自分から場に出せません');
    const activeOne = card.rank === 1 && view.rankOnePlayed >= 1;
    if ([2, 3, 5, 6, 8, 9].includes(card.rank) || activeOne) {
      setTargeting(card); setSelectedTarget(''); return;
    }
    if (onlineConfigured) {
      void sendOnlineCommand({ type: 'play', cardId: card.id });
    } else if (game) {
      try { setGame(playCard(game, PLAYER_ID, card.id)); } catch (error) { flash((error as Error).message); }
    }
  };

  const confirmTarget = () => {
    if (!targeting || !selectedTarget || busy) return;
    const choices = { targetId: selectedTarget, guess };
    if (onlineConfigured) {
      void sendOnlineCommand({ type: 'play', cardId: targeting.id, choices });
      setTargeting(null); setSelectedTarget('');
    } else if (game) {
      try {
        setGame(playCard(game, PLAYER_ID, targeting.id, choices));
        setTargeting(null); setSelectedTarget('');
      } catch (error) { flash((error as Error).message); }
    }
  };

  const draw = (choice: 'one' | 'three') => {
    if (busy) return;
    if (onlineConfigured) {
      void sendOnlineCommand({ type: 'draw', choice });
    } else if (game) {
      try { setGame(drawChoice(game, PLAYER_ID, choice)); } catch (error) { flash((error as Error).message); }
    }
  };

  const chooseScholarCard = (cardId: string) => {
    if (busy) return;
    if (onlineConfigured) {
      void sendOnlineCommand({ type: 'scholar_select', cardId });
    } else if (game) {
      try { setGame(selectScholarCard(game, PLAYER_ID, cardId)); } catch (error) { flash((error as Error).message); }
    }
  };

  const resolveEffect = (discardIndex: number) => {
    if (busy) return;
    if (latestRevealEvent) setDismissedRevealId(latestRevealEvent.id);
    if (onlineConfigured) {
      void sendOnlineCommand({ type: 'resolve', discardIndex });
    } else if (game) {
      try { setGame(resolvePendingEffect(game, PLAYER_ID, discardIndex)); } catch (error) { flash((error as Error).message); }
    }
  };

  const goHome = () => {
    if (screen === 'game' && view && !view.result && !window.confirm('進行中の夜会から退出しますか？')) return;
    setScreen('home'); setGame(null); setOnlineView(null); setLobby(null); setRoomCode(''); setTargeting(null); setGraveOpen(false); setDismissedRevealId(null);
  };

  return (
    <div className={`app-shell screen-${screen}`}>
      {screen === 'home' && (
        <main className="landing-shell">
          <header className="topbar"><Brand onHome={goHome} /><button className="text-button" onClick={() => setRulesOpen(true)}>遊び方</button></header>
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow"><span /> 2–5 PLAYERS · ONLINE</p>
              <h1>その一枚が、<br /><em>運命を塗り替える。</em></h1>
              <p className="lead">記憶と読み合いが交差する、13階位のオンラインカードゲーム。4桁の合言葉だけで、離れた仲間と同じ卓へ。</p>
              <div className="name-field"><label htmlFor="display-name">あなたの呼び名</label><input id="display-name" maxLength={16} value={name} onChange={(event) => setName(event.target.value)} /></div>
              <div className="room-panel">
                <button className="primary-button" type="button" onClick={() => enterLobby('create')} disabled={busy}><span>{busy ? '扉を開いています…' : '新しい部屋をつくる'}</span><span>→</span></button>
                <div className="divider"><span>または</span></div>
                <div className="join-row"><input inputMode="numeric" maxLength={4} placeholder="0000" value={joinCode} onChange={(event) => setJoinCode(event.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="4桁のルームコード" /><button onClick={() => enterLobby('join')} disabled={joinCode.length !== 4 || busy}>部屋に入る</button></div>
              </div>
              <p className="microcopy">登録不要 · スマートフォン対応 · {onlineConfigured ? 'オンライン接続中' : '設定前はプレビュー対戦'}</p>
            </div>
            <div className="table-preview" aria-label="対戦卓のイメージ">
              <div className="orbit" /><div className="orbit orbit-two" />
              <div className="player-chip chip-top"><span>●</span> KIRI</div><div className="player-chip chip-right"><span>●</span> AO</div>
              <div className="deck-stack"><small>残り</small><strong>16</strong></div>
              <div className="card-fan">{[13, 7, 4].map((rank, index) => <CardFace key={rank} card={{ id: `demo-${rank}`, rank }} disabled compact={false} />)}</div>
              <div className="turn-pill"><span /> あなたの手番</div>
            </div>
          </section>
        </main>
      )}

      {screen === 'lobby' && (
        <main className="lobby-shell">
          <header className="game-header"><Brand onHome={goHome} /><div className="header-actions"><button onClick={() => setRulesOpen(true)}>ルール</button><span className={`connection ${onlineConfigured ? 'live' : ''}`}>{onlineConfigured ? 'ONLINE' : 'PREVIEW'}</span></div></header>
          <div className="lobby-layout">
            <section className="lobby-main">
              <p className="eyebrow"><span /> WAITING ROOM</p><h2>夜会の支度</h2>
              <div className="room-code-card"><div><small>ROOM CODE</small><strong>{roomCode}</strong></div><button onClick={() => { navigator.clipboard?.writeText(roomCode); flash('合言葉をコピーしました'); }}>合言葉をコピー</button></div>
              <div className="lobby-section-title"><span>参加者</span><small>{players.length} / {maxPlayers}</small></div>
              <div className="player-list">
                {players.map((player, index) => <div className="lobby-player" key={`${index}-${player}`}><span className="avatar">{player.slice(0, 1).toUpperCase()}</span><div><strong>{player}</strong><small>{index === 0 ? 'HOST' : 'READY'}</small></div><i>●</i></div>)}
                {Array.from({ length: Math.max(0, maxPlayers - players.length) }, (_, index) => <div className="lobby-player empty" key={index}><span className="avatar">+</span><div><strong>待機中</strong><small>合言葉で参加</small></div></div>)}
              </div>
            </section>
            <aside className="setup-panel">
              <div className="panel-heading"><div><small>DECK SETTING</small><h3>カード構成</h3></div>{(!onlineConfigured || lobby?.isHost) && <button onClick={openSettings}>詳しく編集</button>}</div>
              <div className="deck-summary">{Array.from({ length: 13 }, (_, index) => index + 1).map((rank) => <div key={rank}><span>{rank}</span><strong>×{counts[rank]}</strong></div>)}</div>
              <div className="summary-row"><span>合計枚数</span><strong>{Object.values(counts).reduce((a, b) => a + b, 0)}枚</strong></div>
              <label className="player-limit">上限人数<select value={maxPlayers} disabled={onlineConfigured && !lobby?.isHost} onChange={(event) => { const next = Number(event.target.value); setMaxPlayers(next); void configureOnlineRoom(next, counts); }}>{[2,3,4,5].map((value) => <option key={value}>{value}</option>)}</select></label>
              {(!onlineConfigured || lobby?.isHost)
                ? <button className="start-button" onClick={startGame} disabled={busy || players.length < 2}>{busy ? '準備中…' : '夜会を始める'} <span>→</span></button>
                : <button className="start-button" disabled>ホストの開始を待っています</button>}
              <p className="setup-note">{players.length < 2 ? 'あと2人目の参加を待っています' : '開始すると構成が固定されます'}</p>
            </aside>
          </div>
        </main>
      )}

      {screen === 'game' && view && (
        <main className="game-shell">
          <header className="game-header"><Brand onHome={goHome} /><div className="game-status"><span>ROOM {roomCode}</span><span>TURN {view.turnNumber}</span><button onClick={() => setRulesOpen(true)}>?</button></div></header>
          <section className="game-board">
            <div className="opponents">
              {view.players.filter((player) => player.id !== playerId).map((player) => (
                <div className={`opponent ${player.eliminated ? 'eliminated' : ''} ${view.turnPlayerId === player.id ? 'active' : ''}`} key={player.id}>
                  <div className="opponent-avatar">{player.name.slice(0, 1)}</div><div><strong>{player.name}</strong><small>{player.eliminated ? '脱落' : view.turnPlayerId === player.id ? '思案中…' : `${player.handCount}枚`}</small></div><div className="card-back">XIII</div>
                </div>
              ))}
            </div>
            <div className="board-center">
              <div className="pile deck-pile"><span>山札</span><strong>{view.deckCount}</strong></div>
              <div className="center-message"><small>{isMyTurn ? 'YOUR TURN' : 'WAITING'}</small><strong>{isMyTurn ? phaseLabel(view.phase) : `${view.players.find((player) => player.id === view.turnPlayerId)?.name ?? ''}の手番`}</strong><p>{latestEvent?.text}</p></div>
              <button className="pile discard-pile" type="button" onClick={() => setGraveOpen(true)} disabled={!view.discard.length} aria-label={`墓地のカード${view.discard.length}枚をすべて見る`}><span>墓地</span>{view.discard.at(-1) ? <span className="card-face compact-card pile-card" aria-hidden="true"><CardArtwork card={view.discard.at(-1)!} compact /></span> : <strong>0</strong>}<small>{view.discard.length}枚 · タップで一覧</small></button>
            </div>
            <div className="event-strip" aria-live="polite">{view.events.slice(-4).map((event) => <span key={event.id}>{event.text}</span>)}</div>
          </section>
          <section className="hand-dock">
            <div className="self-label"><span className="avatar">{(me?.name ?? name).slice(0, 1)}</span><div><strong>{me?.name ?? name}</strong><small>{me?.eliminated ? '脱落' : isMyTurn ? 'あなたの手番' : '待機中'}</small></div></div>
            <div className="hand-cards">{(me?.ownHand ?? []).map((card) => <CardFace card={card} key={card.id} onClick={() => chooseCard(card)} disabled={busy || !isMyTurn || view.phase !== 'action' || me?.eliminated} />)}</div>
            <div className="draw-actions">
              {isMyTurn && view.phase === 'draw' ? <><button className="draw-one" onClick={() => draw('one')}>山札から<br/><strong>1枚引く</strong></button><button className="draw-three" onClick={() => draw('three')}><span>記憶している？</span><strong>3枚見る</strong></button></> : <div className="waiting-action"><span className="pulse" />{view.phase === 'action' && isMyTurn ? '使うカードを選択' : '夜会の進行を待っています'}</div>}
            </div>
          </section>

          {isMyTurn && view.phase === 'scholar-select' && <div className="modal-backdrop"><div className="choice-modal wide"><small>THREE FUTURES</small><h3>残す未来を一枚選ぶ</h3><div className="choice-cards">{view.scholarCandidates.map((card) => <CardFace card={card} key={card.id} onClick={() => chooseScholarCard(card.id)} disabled={busy} />)}</div></div></div>}
          {isMyTurn && view.phase === 'resolve' && view.pendingEffect && <div className="modal-backdrop"><div className="choice-modal"><small>{view.pendingEffect.kind === 'public-execution' ? 'PUBLIC EXECUTION' : 'HIDDEN CHOICE'}</small><h3>{view.pendingEffect.kind === 'public-execution' ? '墓地へ送る一枚を選ぶ' : 'どちらかを選ぶ'}</h3><div className="choice-cards">{view.pendingEffect.kind === 'public-execution'
            ? view.pendingTargetCards.map((card, index) => <CardFace card={card} key={card.id} onClick={() => resolveEffect(index)} disabled={busy} />)
            : Array.from({ length: view.pendingTargetHandCount }, (_, index) => <button className="mystery-card" key={index} onClick={() => resolveEffect(index)} disabled={busy}><span>XIII</span><strong>{index === 0 ? '左' : '右'}を選ぶ</strong></button>)}</div></div></div>}
          {visibleRevealEvent && <CardRevealModal event={visibleRevealEvent} onNext={() => setDismissedRevealId(visibleRevealEvent.id)} />}
          {view.result && <div className="modal-backdrop result-backdrop"><div className="result-modal"><small>THE NIGHT IS OVER</small><h2>{view.result.winners.includes(playerId) ? 'あなたの勝利' : view.result.winners.length ? `${view.players.find((player) => player.id === view.result?.winners[0])?.name}の勝利` : '引き分け'}</h2><p>{view.result.reason === 'deck-exhausted' ? '最後に残った階位が夜会の行方を決めました。' : '最後まで卓に残った者が運命を掴みました。'}</p><div className="final-hands">{view.players.map((player) => <div key={player.id}><span>{player.name}</span><strong>{player.ownHand?.[0]?.rank ?? '—'}</strong></div>)}</div>{(!onlineConfigured || lobby?.isHost) ? <button className="primary-button" onClick={startGame} disabled={busy}>同じ構成でもう一度 <span>↻</span></button> : <p>ホストの再開を待っています</p>}<button className="ghost-button" onClick={goHome}>タイトルへ戻る</button></div></div>}
        </main>
      )}

      {targeting && view && <div className="modal-backdrop"><div className="choice-modal target-modal"><small>TARGET</small><h3>「{CARD_NAMES[targeting.rank]}」の対象</h3><div className="target-list">{view.players.filter((player) => player.id !== playerId && !player.eliminated).map((player) => <button className={selectedTarget === player.id ? 'selected' : ''} key={player.id} onClick={() => setSelectedTarget(player.id)}><span className="avatar">{player.name.slice(0,1)}</span><strong>{player.name}</strong><span>選択</span></button>)}</div>{targeting.rank === 2 && <label className="guess-field">宣言する階位<select value={guess} onChange={(event) => setGuess(Number(event.target.value))}>{Array.from({ length: 13 }, (_, index) => index + 1).map((rank) => <option key={rank}>{rank}</option>)}</select></label>}<div className="modal-actions"><button className="ghost-button" onClick={() => setTargeting(null)}>戻る</button><button className="primary-button" disabled={!selectedTarget || busy} onClick={confirmTarget}>効果を使う</button></div></div></div>}

      {settingsOpen && <div className="modal-backdrop"><div className="settings-modal"><div className="modal-heading"><div><small>DECK ARCHIVE</small><h3>カード構成を編集</h3></div><button onClick={closeSettings}>×</button></div><div className="preset-bar"><select value={selectedPreset} onChange={(event) => { setSelectedPreset(event.target.value); const preset = presets.find((item) => item.id === event.target.value); if (preset) setCounts({ ...preset.counts }); }}><option value="">保存した構成を選択</option>{presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select><input className="preset-name" aria-label="保存する構成名" maxLength={24} placeholder="構成名を入力" value={presetName} onChange={(event) => setPresetName(event.target.value)} /><button onClick={savePreset} disabled={!presetName.trim()}>名前を付けて保存</button></div><div className="count-editor">{Array.from({ length: 13 }, (_, index) => index + 1).map((rank) => <div key={rank}><span className="mini-sigil">{SIGILS[rank]}</span><label><strong>{rank}</strong><small>{CARD_NAMES[rank]}</small></label><div className="stepper"><button onClick={() => updateCount(rank, -1)}>−</button><input type="number" min="0" max="20" value={counts[rank]} onChange={(event) => setCounts((current) => ({ ...current, [rank]: Math.max(0, Math.min(20, Number(event.target.value) || 0)) }))} /><button onClick={() => updateCount(rank, 1)}>＋</button></div></div>)}</div><div className="settings-footer"><div><strong>合計 {Object.values(counts).reduce((a,b) => a+b,0)}枚</strong><small>{validateCounts(counts, players.length) || 'この構成で開始できます'}</small></div><div className="preset-actions">{selectedPreset && <><button onClick={() => { const preset = presets.find((item) => item.id === selectedPreset); if (preset) exportPreset(preset); }}>書き出す</button><button onClick={() => { const next = presets.filter((item) => item.id !== selectedPreset); setPresets(next); writePresets(next); setSelectedPreset(''); }}>削除</button></>}<button className="primary-button" onClick={() => void applySettings()}>構成を適用</button></div></div></div></div>}

      {graveOpen && view && <div className="modal-backdrop grave-backdrop" role="dialog" aria-modal="true" aria-labelledby="grave-title"><div className="grave-modal"><div className="modal-heading"><div><small>GRAVE ARCHIVE</small><h3 id="grave-title">墓地のカード</h3></div><button type="button" onClick={() => setGraveOpen(false)} aria-label="墓地を閉じる">×</button></div><div className="grave-tools"><span>全{view.discard.length}枚</span><label>並び順<select aria-label="墓地の並び順" value={graveSort} onChange={(event) => setGraveSort(event.target.value as typeof graveSort)}><option value="played">捨てられた順</option><option value="rank-asc">数字の小さい順</option><option value="rank-desc">数字の大きい順</option></select></label></div><div className="grave-grid">{visibleDiscard.map((card, index) => <div className="grave-entry" key={`${card.id}-${index}`}><span className="grave-order">{graveSort === 'played' ? `${index + 1}枚目` : `階位 ${card.rank}`}</span><div className="card-face grave-card" role="img" aria-label={`${card.rank} ${CARD_NAMES[card.rank]}`}><CardArtwork card={card} /></div></div>)}</div><div className="grave-footer"><button className="primary-button" type="button" onClick={() => setGraveOpen(false)}>盤面に戻る</button></div></div></div>}

      {rulesOpen && <div className="rules-backdrop" onClick={() => setRulesOpen(false)}><aside className="rules-drawer" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><small>RULE BOOK</small><h3>13階位の効果</h3></div><button onClick={() => setRulesOpen(false)}>×</button></div><p className="rules-intro">一枚引き、一枚を使う。山札が尽きれば、最後に持つ階位が最も高い者の勝利。</p><div className="rule-list">{Array.from({ length: 13 }, (_, index) => index + 1).map((rank) => <article key={rank}><span>{rank}</span><div><strong>{CARD_NAMES[rank]}</strong><p>{CARD_DESCRIPTIONS[rank]}</p></div><i>{SIGILS[rank]}</i></article>)}</div></aside></div>}
      {taunt && <div className="taunt-screen" role="status"><span>忘れてやーんの</span></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function phaseLabel(phase: string) {
  return ({ draw: '一枚引くか、三枚見るか', action: '使うカードを選ぶ', resolve: '効果を解決する', 'scholar-select': '残す未来を選ぶ', ended: '夜会は終わった' } as Record<string, string>)[phase] ?? phase;
}
