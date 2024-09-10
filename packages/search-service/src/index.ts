import { Tool } from '@langchain/core/tools'
import { Context, Logger, Schema } from 'koishi'
import { ClientConfig } from 'koishi-plugin-chatluna/llm-core/platform/config'
import { PlatformService } from 'koishi-plugin-chatluna/llm-core/platform/service'
import { ChatHubTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { ChatLunaBrowsingChain } from './chain/browsing_chain'
import SerperSearchTool from './tools/serper'
import BingAISearchTool from './tools/bing-api'
import DuckDuckGoSearchTool from './tools/duckduckgo-lite'
import { PuppeteerBrowserTool } from './tools/puppeteerBrowserTool'

export let logger: Logger

export function apply(ctx: Context, config: Config) {
    logger = createLogger(ctx, 'chatluna-search-service')
    const plugin = new ChatLunaPlugin<ClientConfig, Config>(
        ctx,
        config,
        'search-service',
        false
    )

    const adapters: Record<
        string,
        | typeof BingAISearchTool
        | typeof DuckDuckGoSearchTool
        | typeof SerperSearchTool
    > = {
        'bing-api': BingAISearchTool,
        'duckduckgo-lite': DuckDuckGoSearchTool,
        serper: SerperSearchTool
    }

    ctx.on('ready', async () => {
        await plugin.registerToService()

        await plugin.registerTool('web-search', {
            async createTool(params, session) {
                const targetAdapter = config.searchEngine

                // eslint-disable-next-line new-cap
                return new adapters[targetAdapter](
                    config,
                    new PuppeteerBrowserTool(
                        ctx,
                        params.model,
                        params.embeddings
                    ),
                    plugin
                )
            },
            selector() {
                return true
            }
        })

        await plugin.registerTool('web-browser', {
            async createTool(params, session) {
                return new PuppeteerBrowserTool(
                    ctx,
                    params.model,
                    params.embeddings
                )
            },
            selector() {
                return true
            }
        })

        await plugin.registerChatChainProvider(
            'browsing',
            'Browsing 模式，可以从外部获取信息',
            async (params) => {
                const tools = await Promise.all(
                    getTools(
                        ctx.chatluna.platform,
                        (name) =>
                            name === 'search' ||
                            name === 'web-browser' ||
                            name === 'puppeteer-browser'
                    ).map((tool) =>
                        tool.createTool({
                            model: params.model,
                            embeddings: params.embeddings
                        })
                    )
                )

                const model = params.model
                const options = {
                    systemPrompts: params.systemPrompt,
                    botName: params.botName,
                    embeddings: params.embeddings,
                    historyMemory: params.historyMemory,
                    longMemory: params.longMemory,
                    enhancedSummary: config.enhancedSummary
                }

                return ChatLunaBrowsingChain.fromLLMAndTools(
                    model,
                    // only select web-search
                    tools as Tool[],
                    options
                )
            }
        )
    })
}

function getTools(
    service: PlatformService,
    filter: (name: string) => boolean
): ChatHubTool[] {
    const tools = service.getTools().filter(filter)

    return tools.map((name) => service.getTool(name))
}

export interface Config extends ChatLunaPlugin.Config {
    searchEngine: string
    topK: number
    enhancedSummary: boolean

    serperApiKey: string
    serperCountry: string
    serperLocation: string
    serperSearchResults: number

    bingSearchApiKey: string
    bingSearchLocation: string
    azureLocation: string

    puppeteerTimeout: number
    puppeteerIdleTimeout: number
}

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        searchEngine: Schema.union([
            Schema.const('duckduckgo-lite').description('DuckDuckGo (Lite)'),
            Schema.const('serper').description('Serper (Google)'),
            Schema.const('bing-api').description('必应 (Azure API)')
        ])
            .default('duckduckgo-lite')
            .description('搜索引擎'),
        topK: Schema.number()
            .description('参考结果数量（2~20）')
            .min(2)
            .max(20)
            .step(1)
            .default(5),
        enhancedSummary: Schema.boolean()
            .description('是否使用增强摘要')
            .default(false),
        puppeteerTimeout: Schema.number()
            .description('Puppeteer 操作超时时间（毫秒）')
            .default(60000),
        puppeteerIdleTimeout: Schema.number()
            .description('Puppeteer 空闲超时时间（毫秒）')
            .default(300000)
    }).description('搜索设置'),

    Schema.union([
        Schema.object({
            searchEngine: Schema.const('serper').required(),
            serperApiKey: Schema.string()
                .role('secret')
                .description('serper 的 api key')
                .required(),
            serperCountry: Schema.string()
                .description('serper 搜索的国家')
                .default('cn'),
            serperLocation: Schema.string()
                .description('serper 搜索的地区')
                .default('zh-cn'),
            serperSearchResults: Schema.number()
                .min(2)
                .max(20)
                .description('serper 搜索返回的结果数量')
                .default(10)
        }).description('Serper 设置'),
        Schema.object({
            searchEngine: Schema.const('bing-api').required(),
            bingSearchApiKey: Schema.string()
                .role('secret')
                .description('bing api 的 api key')
                .required(),
            bingSearchLocation: Schema.string()
                .description('bing api 搜索的地区')
                .default('zh-CN'),
            azureLocation: Schema.string()
                .description('azure api 搜索的地区')
                .default('global')
        }).description('Bing API 设置'),
        Schema.object({})
    ])
]) as Schema<Config>

export const inject = ['chatluna', 'puppeteer']

export const name = 'chatluna-search-service'
