import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {
  createGame, drawChoice, playCard, projectForPlayer, resolvePendingEffect, selectScholarCard,
  type GameState,
} from '../_shared/game.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const authorization = request.headers.get('Authorization');
    if (!authorization) return reply({ error: '認証が必要です' }, 401);
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const service = createClient(url, serviceKey, { auth: { persistSession: false } });
    const token = authorization.replace(/^Bearer\s+/i, '');
    const { data: authData, error: authError } = await service.auth.getUser(token);
    if (authError || !authData.user) return reply({ error: 'セッションが無効です' }, 401);
    const userId = authData.user.id;
    const body = await request.json();
    const action = String(body.action || '');

    if (action === 'create_room') {
      const displayName = cleanName(body.name);
      const maxPlayers = Math.max(2, Math.min(5, Number(body.maxPlayers) || 5));
      const counts = cleanCounts(body.counts);
      let room: { id: string; code: string } | null = null;
      for (let attempt = 0; attempt < 30 && !room; attempt += 1) {
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
        const { data, error } = await service.from('rooms').insert({
          code, host_user_id: userId, max_players: maxPlayers, card_counts: counts,
        }).select('id,code').single();
        if (!error) room = data;
        else if (error.code !== '23505') throw error;
      }
      if (!room) throw new Error('空いている合言葉を発行できませんでした');
      await service.from('room_players').insert({ room_id: room.id, user_id: userId, player_id: 'player-1', display_name: displayName, seat: 0 });
      return reply({ code: room.code, playerId: 'player-1' });
    }

    const code = String(body.code || '').padStart(4, '0');
    const { data: room, error: roomError } = await service.from('rooms').select('*').eq('code', code).gt('expires_at', new Date().toISOString()).single();
    if (roomError || !room) return reply({ error: 'その部屋は見つかりません' }, 404);

    if (action === 'join_room') {
      if (room.status !== 'lobby') return reply({ error: 'すでに夜会が始まっています' }, 409);
      const { data: roster } = await service.from('room_players').select('seat,user_id,player_id').eq('room_id', room.id).order('seat');
      const existing = roster?.find((player) => player.user_id === userId);
      if (existing) return reply({ code, playerId: existing.player_id });
      if ((roster?.length ?? 0) >= room.max_players) return reply({ error: 'この部屋は満員です' }, 409);
      const used = new Set((roster ?? []).map((player) => player.seat));
      const seat = [0, 1, 2, 3, 4].find((candidate) => !used.has(candidate))!;
      const playerId = `player-${seat + 1}`;
      const { error } = await service.from('room_players').insert({ room_id: room.id, user_id: userId, player_id: playerId, display_name: cleanName(body.name), seat });
      if (error) throw error;
      await broadcast(service, code, room.version);
      return reply({ code, playerId });
    }

    const { data: membership } = await service.from('room_players').select('player_id').eq('room_id', room.id).eq('user_id', userId).single();
    if (!membership) return reply({ error: 'この部屋には参加していません' }, 403);

    if (action === 'snapshot') {
      const { data: stored } = await service.from('game_states').select('state').eq('room_id', room.id).maybeSingle();
      if (!stored) {
        return reply({ lobby: await lobbyFor(service, room, userId) });
      }
      return reply({ view: projectForPlayer(stored.state as GameState, membership.player_id) });
    }

    if (action === 'configure_room') {
      if (room.host_user_id !== userId) return reply({ error: 'ホストだけが構成を変更できます' }, 403);
      if (room.status !== 'lobby') return reply({ error: '開始後は構成を変更できません' }, 409);
      const { count } = await service.from('room_players').select('*', { count: 'exact', head: true }).eq('room_id', room.id);
      const maxPlayers = Math.max(2, Math.min(5, Number(body.maxPlayers) || room.max_players));
      if ((count ?? 0) > maxPlayers) return reply({ error: '現在の参加者より少ない人数にはできません' }, 409);
      const counts = cleanCounts(body.counts);
      const version = Number(room.version) + 1;
      const { data: updated, error } = await service.from('rooms').update({
        max_players: maxPlayers, card_counts: counts, version,
      }).eq('id', room.id).select('*').single();
      if (error || !updated) throw error ?? new Error('構成を更新できませんでした');
      await broadcast(service, code, version);
      return reply({ lobby: await lobbyFor(service, updated, userId) });
    }

    if (action === 'command') {
      const commandId = String(body.commandId || '');
      if (!/^[0-9a-f-]{36}$/i.test(commandId)) return reply({ error: 'commandIdが不正です' }, 400);
      const { data: receipt } = await service.from('command_receipts').select('resulting_version').eq('room_id', room.id).eq('command_id', commandId).maybeSingle();
      if (receipt) {
        const { data: stored } = await service.from('game_states').select('state').eq('room_id', room.id).single();
        return reply({ view: projectForPlayer(stored!.state as GameState, membership.player_id), replayed: true });
      }

      const command = body.command ?? {};
      if (command.type === 'start') {
        if (room.host_user_id !== userId) return reply({ error: 'ホストだけが開始できます' }, 403);
        const { data: roster } = await service.from('room_players').select('display_name').eq('room_id', room.id).order('seat');
        if ((roster?.length ?? 0) < 2) return reply({ error: '2人以上必要です' }, 409);
        const maxPlayers = Math.max(2, Math.min(5, Number(command.maxPlayers) || room.max_players));
        if (roster!.length > maxPlayers) return reply({ error: '参加者数が上限を超えています' }, 409);
        const counts = cleanCounts(command.counts ?? room.card_counts);
        const state = createGame(roster!.map((player) => player.display_name), counts);
        await service.from('game_states').upsert({ room_id: room.id, state, version: state.version });
        await service.from('rooms').update({
          status: 'playing', version: state.version, max_players: maxPlayers, card_counts: counts,
        }).eq('id', room.id);
        await service.from('command_receipts').insert({ room_id: room.id, command_id: commandId, user_id: userId, resulting_version: state.version });
        await broadcast(service, code, state.version);
        return reply({ view: projectForPlayer(state, membership.player_id) });
      }

      const expectedVersion = Number(body.expectedVersion);
      const { data: stored } = await service.from('game_states').select('state,version').eq('room_id', room.id).single();
      if (!stored || stored.version !== expectedVersion) return reply({ error: '盤面が更新されました。再同期してください。', code: 'VERSION_CONFLICT' }, 409);
      let state = stored.state as GameState;
      if (command.type === 'draw') state = drawChoice(state, membership.player_id, command.choice);
      else if (command.type === 'scholar_select') state = selectScholarCard(state, membership.player_id, command.cardId);
      else if (command.type === 'play') state = playCard(state, membership.player_id, command.cardId, command.choices);
      else if (command.type === 'resolve') state = resolvePendingEffect(state, membership.player_id, Number(command.discardIndex));
      else return reply({ error: '不明なコマンドです' }, 400);

      const { data: updated } = await service.from('game_states').update({ state, version: state.version, updated_at: new Date().toISOString() }).eq('room_id', room.id).eq('version', expectedVersion).select('version');
      if (!updated?.length) return reply({ error: '盤面が更新されました。再同期してください。', code: 'VERSION_CONFLICT' }, 409);
      await service.from('rooms').update({ version: state.version, status: state.result ? 'finished' : 'playing' }).eq('id', room.id);
      await service.from('command_receipts').insert({ room_id: room.id, command_id: commandId, user_id: userId, resulting_version: state.version });
      await broadcast(service, code, state.version);
      return reply({ view: projectForPlayer(state, membership.player_id) });
    }
    return reply({ error: '不明な操作です' }, 400);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : 'サーバーエラー' }, 500);
  }
});

function cleanName(value: unknown) {
  const name = String(value || '').trim().slice(0, 16);
  if (!name) throw new Error('呼び名を入力してください');
  return name;
}

function cleanCounts(value: unknown) {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const counts: Record<number, number> = {};
  for (let rank = 1; rank <= 13; rank += 1) {
    counts[rank] = Math.max(0, Math.min(20, Math.floor(Number(source[String(rank)]) || 0)));
  }
  return counts;
}

async function lobbyFor(
  service: ReturnType<typeof createClient>,
  room: Record<string, unknown>,
  userId: string,
) {
  const { data: roster, error } = await service.from('room_players')
    .select('player_id,display_name,seat,connected')
    .eq('room_id', room.id)
    .order('seat');
  if (error) throw error;
  return {
    code: room.code,
    status: room.status,
    version: Number(room.version),
    isHost: room.host_user_id === userId,
    maxPlayers: Number(room.max_players),
    counts: room.card_counts,
    players: (roster ?? []).map((player) => ({
      playerId: player.player_id,
      displayName: player.display_name,
      seat: player.seat,
      connected: player.connected,
    })),
  };
}

async function broadcast(service: ReturnType<typeof createClient>, code: string, version: number) {
  const channel = service.channel(`room:${code}`, { config: { private: true } });
  await channel.send({ type: 'broadcast', event: 'state_changed', payload: { version } });
  await service.removeChannel(channel);
}
