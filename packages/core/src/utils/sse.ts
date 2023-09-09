import * as fetchType from 'undici/types/fetch'
import { ChatHubError, ChatHubErrorCode } from './error'

// eslint-disable-next-line generator-star-spacing
export async function* sseIterable(response: fetchType.Response) {
    if (!response.ok) {
        const error = await response.json().catch(() => ({}))

        throw new ChatHubError(
            ChatHubErrorCode.NETWORK_ERROR,
            new Error(`${response.status} ${response.statusText} ${JSON.stringify(error)}`)
        )
    }

    const reader = response.body.getReader()

    const decoder = new TextDecoder('utf-8')

    try {
        while (true) {
            const { value, done } = await reader.read()

            if (done) {
                yield '[DONE]'
                return
            }

            const decodeValue = decoder.decode(value)

            if (decodeValue.trim().length === 0) {
                continue
            }

            const splitted = decodeValue.split('\n\n')

            for (let i = 0; i < splitted.length; i++) {
                let item = splitted[i]

                if (item.trim().length === 0) {
                    continue
                } else {
                    if (item.startsWith('data: ')) {
                        item = item.substring(6)
                    }

                    yield item
                }
            }
        }
    } finally {
        reader.releaseLock()
    }
}
