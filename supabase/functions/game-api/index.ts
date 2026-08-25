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
      let room: { id: string; code: string } | null = null;
      for (let attempt = 0; attempt < 30 && !room; attempt += 1) {
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
        const { data, error } = await service.from('rooms').insert({
          code, host_user_id: userId, max_players: maxPlayers, card_counts: body.counts,
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
        const { data: roster } = await service.from('room_players').select('player_id,display_name,seat,connected').eq('room_id', room.id).order('seat');
        return reply({ lobby: { code, status: room.status, version: room.version, hostUserId: room.host_user_id, maxPlayers: room.max_players, counts: room.card_counts, players: roster } });
      }
      return reply({ view: projectForPlayer(stored.state as GameState, membership.player_id) });
    }

    if (action === 'command') {
      const commandId = String(body.commandId || '');
      if (!/^[0-9a-f-]{36}$/i.test(commandId)) return reply({ error: 'commandIdが不正です' }, 400);
      const { data: receipt } = await service.from('command_receipts').select('resulting_version').eq('room_id', room.id).eq('command_id', commandId).maybeSingle();
      if (receipt) {
        const { data: stored } = await service.from('game_states').select('state').eq('room_id', room.id).single();
        return reply({ view: projectForPlayer(stored!.state as GameState, membership.player_id), replayed: true });
      }

      if (body.command?.type === 'start') {
        if (room.host_user_id !== userId) return reply({ error: 'ホストだけが開始できます' }, 403);
        const { data: roster } = await service.from('room_players').select('display_name').eq('room_id', room.id).order('seat');
        if ((roster?.length ?? 0) < 2) return reply({ error: '2人以上必要です' }, 409);
        const state = createGame(roster!.map((player) => player.display_name), room.card_counts);
        await service.from('game_states').upsert({ room_id: room.id, state, version: state.version });
        await service.from('rooms').update({ status: 'playing', version: state.version }).eq('id', room.id);
        await service.from('command_receipts').insert({ room_id: room.id, command_id: commandId, user_id: userId, resulting_version: state.version });
        await broadcast(service, code, state.version);
        return reply({ view: projectForPlayer(state, membership.player_id) });
      }

      const expectedVersion = Number(body.expectedVersion);
      const { data: stored } = await service.from('game_states').select('state,version').eq('room_id', room.id).single();
      if (!stored || stored.version !== expectedVersion) return reply({ error: '盤面が更新されました。再同期してください。', code: 'VERSION_CONFLICT' }, 409);
      const command = body.command ?? {};
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

async function broadcast(service: ReturnType<typeof createClient>, code: string, version: number) {
  const channel = service.channel(`room:${code}`, { config: { private: true } });
  await channel.send({ type: 'broadcast', event: 'state_changed', payload: { version } });
  await service.removeChannel(channel);
}
