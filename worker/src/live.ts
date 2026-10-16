// Live: one Durable Object that every open board and overlay keeps a WebSocket to (BASE/live), so a change made
// anywhere shows everywhere without polling. The Worker posts it a message after each change and it passes the
// message on to every socket. Messages say only what changed ({ type: 'thread', id } or { type: 'screens' }); each page
// fetches the rest through the API, so nothing private goes over this channel that the API wouldn't give it anyway.
//
// The sockets are accepted with the hibernation API: an idle canvas costs nothing, and the object wakes when a
// message is to be sent.

export class Live {
    constructor(private readonly state: DurableObjectState) {}

    async fetch(request: Request): Promise<Response> {
        if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
            const { 0: client, 1: server } = new WebSocketPair();
            this.state.acceptWebSocket(server);
            return new Response(null, { status: 101, webSocket: client });
        }
        if (request.method === 'POST') {
            const message = await request.text();
            for (const ws of this.state.getWebSockets()) {
                try {
                    ws.send(message);
                } catch {
                    // a socket that's closing: its page reconnects and fetches afresh
                }
            }
            return new Response(null, { status: 204 });
        }
        return new Response('Not found', { status: 404 });
    }

    // the pages only listen; nothing they send means anything
    webSocketMessage(): void {}

    webSocketClose(ws: WebSocket, code: number, reason: string): void {
        try {
            ws.close(code, reason);
        } catch {
            // already closed by the runtime's own reply
        }
    }
}
