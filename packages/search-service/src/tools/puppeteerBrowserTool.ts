/* eslint-disable max-len */
import { Tool } from '@langchain/core/tools'
import { Context } from 'koishi'
import type { Page } from 'puppeteer-core'
import type {} from 'koishi-plugin-puppeteer'
import { BaseLanguageModel } from '@langchain/core/language_models/base'
import { Embeddings } from '@langchain/core/embeddings'
import { MemoryVectorStore } from 'koishi-plugin-chatluna/llm-core/vectorstores'
import { Document } from '@langchain/core/documents'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'

export interface PuppeteerBrowserToolOptions {
    timeout?: number
    idleTimeout?: number
}

export class PuppeteerBrowserTool extends Tool {
    name = 'web_browser'
    description = `A tool to browse web pages using Puppeteer.
    IMPORTANT: This tool can only be used ONCE per conversation turn.
    Input should be in the format: 'action params'.
    You must use the 'open' action first before any other action.
    Available actions:
    - open [url]: Open a web page (required first action)
    - summarize [search_text?]: Simple summarize the current page, optionally with a search text.
    - text [search_text?]: Get the content of the current page, optionally with a search text
    - select [selector]: Select content from a specific div
    - previous: Go to the previous page
    - get-html: Get the HTML content of the current page
    - get-structured-urls: Get structured URLs from the current page
    Example usage:
    'open https://example.com'
    Do not chain multiple actions in a single call. Use only one action per tool use.
    After using this tool, you must process the result before considering using it again in the next turn.`

    private page: Page | null = null
    private lastActionTime: number = Date.now()
    private readonly timeout: number = 30000 // 30 seconds timeout
    private readonly idleTimeout: number = 300000 // 5 minutes idle timeout
    private model: BaseLanguageModel
    private embeddings: Embeddings
    private ctx: Context

    private actions: Record<string, (params: string) => Promise<string>> = {
        open: this.openPage.bind(this),
        summarize: this.summarizePage.bind(this),
        text: this.getPageText.bind(this),
        select: this.selectDiv.bind(this),
        previous: this.goToPreviousPage.bind(this),
        'get-html': this.getHtml.bind(this),
        'get-structured-urls': this.getStructuredUrls.bind(this)
    }

    constructor(
        ctx: Context,
        model: BaseLanguageModel,
        embeddings: Embeddings,
        options: PuppeteerBrowserToolOptions = {}
    ) {
        super()

        this.ctx = ctx
        this.model = model
        this.embeddings = embeddings
        this.timeout = options.timeout || this.timeout
        this.idleTimeout = options.idleTimeout || this.idleTimeout
        this.startIdleTimer()
    }

    async _call(input: string): Promise<string> {
        try {
            let action: string
            let params: string

            const firstSpaceIndex = input.indexOf(' ')
            if (firstSpaceIndex !== -1) {
                action = input.slice(0, firstSpaceIndex).trim().toLowerCase()
                params = input.slice(firstSpaceIndex + 1).trim()
            } else {
                // Check if the entire input is a valid action
                action = input.trim().toLowerCase()
                if (!this.actions[action]) {
                    action = 'open'
                    params = input.trim()
                } else {
                    params = ''
                }
            }

            this.lastActionTime = Date.now()

            if (this.actions[action]) {
                return await this.actions[action](params)
            } else {
                return `Unknown action: ${action}. Available actions: ${Object.keys(this.actions).join(', ')}`
            }
        } catch (error) {
            if (error instanceof Error) {
                return `Error: ${error.message}`
            }
            return 'An unknown error occurred'
        }
    }

    private async initBrowser() {
        try {
            if (!this.page) {
                const puppeteer = this.ctx.puppeteer
                if (!puppeteer) {
                    throw new Error('Puppeteer service is not available')
                }
                this.page = await puppeteer.browser.newPage()
            }
        } catch (error) {
            console.error(error)
            throw error
        }
    }

    private async openPage(url: string): Promise<string> {
        try {
            await this.initBrowser()
            await this.page!.goto(url, {
                waitUntil: 'networkidle2',
                timeout: this.timeout
            })
            return 'Page opened successfully'
        } catch (error) {
            console.error(error)
            return `Error opening page: ${error.message}`
        }
    }

    private async summarizePage(searchText?: string): Promise<string> {
        try {
            const text = await this.getPageText(searchText)
            return this.summarizeText(text, searchText)
        } catch (error) {
            console.error(error)
            return `Error summarizing page: ${error.message}`
        }
    }

    private async getPageText(searchText?: string): Promise<string> {
        try {
            if (!this.page)
                return 'No page is open, please use open action first'

            const text = await this.page.evaluate(() => {
                const baseUrl = window.location.href
                let structuredText = ''

                // fix esbuild
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                window['__name'] = (func: any) => func

                const processNode = (node: Node, depth: number = 0) => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        const trimmedText = node.textContent?.trim()
                        if (trimmedText) {
                            structuredText += ' ' + trimmedText
                        }
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        const element = node as Element
                        const tagName = element.tagName.toLowerCase()

                        switch (tagName) {
                            case 'a': {
                                const href = element.getAttribute('href')
                                if (href) {
                                    try {
                                        const fullUrl = new URL(
                                            href,
                                            baseUrl
                                        ).toString()
                                        structuredText += ` [${element.textContent?.trim()}](${fullUrl})`
                                    } catch (error) {
                                        console.error('Invalid URL:', error)
                                        structuredText += ` [${element.textContent?.trim()}](${href})`
                                    }
                                } else {
                                    structuredText +=
                                        ' ' + element.textContent?.trim()
                                }
                                break
                            }
                            case 'p':
                            case 'h1':
                            case 'h2':
                            case 'h3':
                            case 'h4':
                            case 'h5':
                            case 'h6':
                                structuredText += '\n'.repeat(depth > 0 ? 1 : 2)
                                structuredText += `${'#'.repeat(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].indexOf(tagName) + 1)} `
                                for (const child of element.childNodes) {
                                    processNode(child, depth + 1)
                                }
                                structuredText += '\n'
                                break
                            case 'ul':
                            case 'ol':
                                structuredText += '\n'
                                for (const child of element.childNodes) {
                                    processNode(child, depth + 1)
                                }
                                structuredText += '\n'
                                break
                            case 'li':
                                structuredText +=
                                    '\n' + '  '.repeat(depth) + '- '
                                for (const child of element.childNodes) {
                                    processNode(child, depth + 1)
                                }
                                break
                            case 'br':
                                structuredText += '\n'
                                break
                            case 'strong':
                            case 'b':
                                structuredText += ` **${element.textContent?.trim()}** `
                                break
                            case 'em':
                            case 'i':
                                structuredText += ` *${element.textContent?.trim()}* `
                                break
                            case 'code':
                                structuredText += ` \`${element.textContent?.trim()}\` `
                                break
                            case 'pre':
                                structuredText +=
                                    '\n```\n' +
                                    element.textContent?.trim() +
                                    '\n```\n'
                                break
                            case 'blockquote':
                                structuredText +=
                                    '\n> ' +
                                    element.textContent
                                        ?.trim()
                                        .replace(/\n/g, '\n> ') +
                                    '\n'
                                break
                            case 'table':
                                structuredText += '\n'
                                for (const child of element.childNodes) {
                                    processNode(child, depth + 1)
                                }
                                structuredText += '\n'
                                break
                            case 'tr':
                                structuredText += '|'
                                for (const child of element.childNodes) {
                                    processNode(child, depth + 1)
                                }
                                structuredText += '\n'
                                break
                            case 'th':
                            case 'td':
                                structuredText += ` ${element.textContent?.trim()} |`
                                break
                            case 'span': {
                                const className = element.className

                                if (className.includes('highlight')) {
                                    structuredText += ` **${element.textContent?.trim()}** `
                                } else if (className.includes('italic')) {
                                    structuredText += ` *${element.textContent?.trim()}* `
                                } else {
                                    structuredText += ` ${element.textContent?.trim()} `
                                }
                                break
                            }
                            default:
                                if (
                                    tagName !== 'script' &&
                                    tagName !== 'style'
                                ) {
                                    for (const child of element.childNodes) {
                                        processNode(child, depth)
                                    }
                                }
                        }
                    }
                }

                processNode(document.body)
                return structuredText.trim().replace(/\n{3,}/g, '\n\n')
            })

            if (searchText) {
                const textSplitter = new RecursiveCharacterTextSplitter({
                    chunkSize: 2000,
                    chunkOverlap: 200
                })
                const texts = await textSplitter.splitText(text)

                const docs = texts.map(
                    (pageContent) =>
                        new Document({
                            pageContent,
                            metadata: []
                        })
                )

                const vectorStore = await MemoryVectorStore.fromDocuments(
                    docs,
                    this.embeddings
                )
                const results = await vectorStore.similaritySearch(
                    searchText,
                    20
                )
                return results.map((res) => res.pageContent).join('\n\n')
            }

            return text
        } catch (error) {
            console.error(error)
            return `Error getting page text: ${error.message}`
        }
    }

    private async summarizeText(
        text: string,
        searchText?: string
    ): Promise<string> {
        try {
            const input = `Text: ${text}

Please provide a comprehensive and objective summary of the above text${searchText ? `, with a focus on "${searchText}"` : ''}. Your summary should be well-structured and thorough, including:

1. An overview of the main topic or themes (1 paragraph)
2. A detailed breakdown of key points, arguments, or findings (3-4 paragraphs)
3. Important supporting evidence, data, or examples (1-2 paragraphs)
4. Any contrasting viewpoints or limitations mentioned in the text (1 paragraph, if applicable)
5. Implications or conclusions drawn from the main points (1 paragraph)

Guidelines for the summary:
 - Organize the content into clear, logically flowing paragraphs
 - Maintain an objective tone throughout, avoiding sensationalism or bias
 - Use transitional phrases to connect ideas and ensure smooth flow between paragraphs
 - Include relevant quotes or statistics from the original text to support key points
 - If applicable, incorporate up to 5 important links from the text, contextually integrated into your summary
 - Ensure all information is accurate and derived from the provided text
 - IMPORTANT: Use the exact same language as the input text for your summary. Do not translate or change the language.

Please aim for a balanced, informative summary that a reader could use to gain a comprehensive understanding of the original content.

CRITICAL: Your summary MUST be in the same language as the original text. Do not translate or change the language under any circumstances.`

            const summary = await this.model.invoke(input)
            return summary.content
        } catch (error) {
            console.error(error)
            return `Error summarizing text: ${error.message}`
        }
    }

    private async selectDiv(selector: string): Promise<string> {
        try {
            if (!this.page) return 'No page is open'
            const content = await this.page.evaluate((sel) => {
                const element = document.querySelector(sel)
                return element ? element.textContent : 'Element not found'
            }, selector)
            return content || 'No content found'
        } catch (error) {
            console.error(`Error selecting div: ${error}`)
            return `Error selecting div: ${error.message}`
        }
    }

    private async goToPreviousPage(): Promise<string> {
        try {
            if (!this.page) return 'No page is open'
            await this.page.goBack({
                waitUntil: 'networkidle2',
                timeout: this.timeout
            })
            return 'Navigated to previous page'
        } catch (error) {
            console.error(`Error navigating to previous page: ${error.message}`)
            return `Error navigating to previous page: ${error}`
        }
    }

    private async getHtml(): Promise<string> {
        try {
            if (!this.page) return 'No page is open'
            return await this.page.content()
        } catch (error) {
            console.error(error)
            return `Error getting HTML: ${error.message}`
        }
    }

    private async getStructuredUrls(): Promise<string> {
        try {
            if (!this.page) return 'No page is open'
            return await this.page.evaluate(() => {
                const urlStructure: { [key: string]: string[] } = {
                    search: [],
                    navigation: [],
                    external: [],
                    other: []
                }

                const currentHost = window.location.hostname

                document.querySelectorAll('a').forEach((a) => {
                    const href = a.href
                    if (!href) return

                    const url = new URL(href)
                    const linkText = a.textContent?.trim() || ''

                    if (url.hostname === currentHost) {
                        if (
                            url.pathname.includes('search') ||
                            url.search.includes('q=')
                        ) {
                            urlStructure.search.push(`${linkText}: ${href}`)
                        } else if (
                            a.closest('nav') ||
                            a.matches('header a, footer a')
                        ) {
                            urlStructure.navigation.push(`${linkText}: ${href}`)
                        } else {
                            urlStructure.other.push(`${linkText}: ${href}`)
                        }
                    } else {
                        urlStructure.external.push(`${linkText}: ${href}`)
                    }
                })

                return JSON.stringify(urlStructure, null, 2)
            })
        } catch (error) {
            console.error(error)
            return `Error getting structured URLs: ${error.message}`
        }
    }

    private startIdleTimer() {
        this.ctx.setInterval(() => {
            if (Date.now() - this.lastActionTime > this.idleTimeout) {
                this.closeBrowser()
            }
        }, 60000) // Check every minute
        this.ctx.on('dispose', async () => {
            this.closeBrowser()
        })
    }

    async closeBrowser() {
        try {
            if (this.page) {
                await this.page.close()
                this.page = null
            }
        } catch (error) {
            this.ctx.logger.error(error)
        }
    }
}
