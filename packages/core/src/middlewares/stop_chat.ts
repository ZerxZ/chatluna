import { Context } from 'koishi'
import { Config } from '../config'
import { ChainMiddlewareRunStatus, ChatChain } from '../chains/chain'
import { getAllJoinedConversationRoom } from '../chains/rooms'
import { getRequestId } from './request_model'

export function apply(ctx: Context, config: Config, chain: ChatChain) {
    chain
        .middleware('stop_chat', async (session, context) => {
            const { command } = context

            if (command !== 'stop_chat') return ChainMiddlewareRunStatus.SKIPPED

            let room = context.options.room

            if (room == null && context.options.room_resolve != null) {
                // 尝试完整搜索一次

                const rooms = await getAllJoinedConversationRoom(
                    ctx,
                    session,
                    true
                )

                const roomId = parseInt(context.options.room_resolve?.name)

                room = rooms.find(
                    (room) =>
                        room.roomName === context.options.room_resolve?.name ||
                        room.roomId === roomId
                )
            }

            if (room == null) {
                context.message = '未找到指定的房间。'
                return ChainMiddlewareRunStatus.STOP
            }

            const requestId = getRequestId(session, room)

            if (requestId == null) {
                context.message = '当前未在房间中对话。'
                return ChainMiddlewareRunStatus.STOP
            }

            const status = await ctx.chatluna.stopChat(room, requestId)

            if (status === null) {
                context.message = '未在当前房间中对话。'
            } else {
                context.message = '停止对话失败。'
            }

            return ChainMiddlewareRunStatus.STOP
        })
        .after('lifecycle-handle_command')
}

declare module '../chains/chain' {
    interface ChainMiddlewareName {
        stop_chat: never
    }
}
