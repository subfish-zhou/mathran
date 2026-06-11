import type { SSEEvent } from './chat-handler';

export function createSSEResponse(
  events: AsyncIterable<SSEEvent>,
  /**
   * Phase 3 (C — abort): invoked when the ReadableStream is cancelled (the
   * client `fetch` was aborted — Stop button / in-flight message delete /
   * navigation). The route uses this to trip an AbortController that stops the
   * BACKEND agent loop, so we don't keep burning tokens after the UI is gone.
   */
  onCancel?: () => void,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          // Backward-compatible events
          if (event.type === 'done') {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, conversationId: event.conversationId })}\n\n`));
          } else if (event.type === 'error') {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: event.error })}\n\n`));
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errorMsg })}\n\n`));
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Client disconnected / aborted the fetch → stop the backend loop.
      try {
        onCancel?.();
      } catch {
        // best-effort
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
