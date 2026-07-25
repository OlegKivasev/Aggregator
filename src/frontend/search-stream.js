export const openSearchStream = (url) => {
  const controller = new AbortController();
  const stream = {
    closed: false,
    onmessage: null,
    onerror: null,
    close() {
      this.closed = true;
      controller.abort();
    },
  };

  queueMicrotask(async () => {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Search stream returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!stream.closed) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let eventEnd = buffer.indexOf("\n\n");
        while (eventEnd !== -1) {
          const event = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

          if (data) {
            stream.onmessage?.({ data });
          }

          eventEnd = buffer.indexOf("\n\n");
        }

        if (done) {
          break;
        }
      }

      if (!stream.closed) {
        stream.onerror?.(new Error("Search stream closed before completion"));
      }
    } catch (error) {
      if (!stream.closed) {
        stream.onerror?.(error);
      }
    }
  });

  return stream;
};
