class BackendTradeBuffer
{
    /**
     * @param {Function} broadcastCallback - The function that actually transmits the payload to your frontend clients
     * @param {number} flushIntervalMs - Frequency of socket transmissions (default: 250ms)
     */
    constructor(broadcastCallback, flushIntervalMs = 250)
    {
        this.buffer = {}; // In-memory bucket: { AAPL: [tick, tick], TSLA: [tick] }
        this.broadcastCallback = broadcastCallback;
        this.flushIntervalMs = flushIntervalMs;
        this.timerId = null;

        this.startFlushingLoop();
    }

    /**
     * Pushes a raw tick from the Alpaca stream into the backend buffer
     */
    addTick(trade)
    {
        const symbol = trade.Symbol;

        if (!this.buffer[symbol])
        {
            this.buffer[symbol] = [];
        }

        // Sanitize and keep only the essential fields to reduce WebSocket network payload size
        this.buffer[symbol].push(trade);
    }

    /**
     * Runs continuously to flush accumulated ticks to the frontend
     */
    startFlushingLoop()
    {
        this.timerId = setInterval(() =>
        {
            const activeSymbols = Object.keys(this.buffer);

            if (activeSymbols.length === 0) return;

            activeSymbols.forEach((symbol) =>
            {
                const ticksArray = this.buffer[symbol];

                // Skip tickers that received no volume during this 250ms window
                if (ticksArray.length === 0) return;

                // // Construct the structured broadcast message
                // const broadcastPayload = {
                //     type: 'TRADE_BATCH',
                //     symbol: symbol,
                //     ticks: ticksArray.at(-1)
                // };

                // Fire the callback to send this data over your frontend websocket server
                this.broadcastCallback(ticksArray.at(-1));

                // Instantly wipe the memory space for this symbol for the next window
                this.buffer[symbol] = [];
            });

        }, this.flushIntervalMs);
    }

    /**
     * Stop the loop if the server restarts or tears down
     */
    stop()
    {
        if (this.timerId) clearInterval(this.timerId);
    }
}

export default BackendTradeBuffer;
