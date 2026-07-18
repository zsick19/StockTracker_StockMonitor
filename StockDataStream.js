const Alpaca = require('@alpacahq/alpaca-trade-api')

class DataStream
{
    constructor({ apiKey, secretKey })
    {
        this.alpaca = new Alpaca({ keyId: apiKey, secretKey, })
        const socket = this.alpaca.data_stream_v2;
        this.socket = socket

        this.socket.onConnect(() =>
        {

            console.log("Connected To Alpaca Data Stream");
            this.socket.session.subscriptions.quotes = []
        });
        this.socket.onError((err) =>
        {
            console.log(`Error occurred With Stock Stream`)
            // console.log(err);
        });
        this.socket.onStateChange((state) =>
        {
            // console.log(this.socket?.ws.readyState)
            console.log(`State Change: ${state}`);
        });

        this.socket.connect();
    }

    addTickerToAlpacaDataStream(tickerToAdd)
    {
        try
        {
            this.socket.subscribeForTrades(tickerToAdd)
            console.log(`${tickerToAdd.toString()} added to alpaca data stream!`)
        } catch (error)
        {
            console.log(`Error adding ${tickerToAdd.toString()} to Trade Data Stream.`, error)
        }
    }
    removeTickerFromAlpacaDataStream(tickerToRemove)
    {
        try
        {
            this.socket.subscribeForTrades(tickerToRemove)
            console.log(`${tickerToRemove.toString()} removed from trade stream.`)
        } catch (error)
        {
            console.log(`Error removing ${tickerToRemove.toString()} from Trade Data Stream.`, error)
        }
    }

    addTickerToAlpacaQuoteStream(tickerToAdd)
    {
        try
        {
            if (!this.socket.session.subscriptions.quotes) this.socket.session.subscriptions.quotes = []
            this.socket.subscribeForQuotes(tickerToAdd);
            console.log(`${tickerToAdd.toString()} added to alpaca quote data stream`)
        } catch (error)
        {
            console.log(`Error adding ${tickerToAdd.toString()} to alpaca Quote Data Stream.`, error)
        }
    }

    removeTickerFromAlpacaQuoteStream(tickerToRemove)
    {
        try
        {
            this.socket.unsubscribeFromQuotes(tickerToRemove)
            console.log(`${tickerToRemove.toString()} removed from alpaca quote data stream`)
        } catch (error)
        {
            console.log(`Error removing ${tickerToRemove.toString()} from Alpaca Quote Data Stream.`, error)
        }
    }

    addTickerToAlpacaMinuteDataStream(tickerToAdd)
    {
        try
        {
            this.socket.subscribeForBars(tickerToAdd)
            // console.log(`${tickerToAdd.toString()} added to alpaca minute stream!`)
        } catch (error)
        {
            console.log(`Error adding ${tickerToAdd.toString()} to Minute Data Stream 2`, error)
        }

    }
    removeTickerFromMinuteAddToTradeStream(tickerToSwitch)
    {
        try
        {
            this.socket.unsubscribeFromBars(tickerToSwitch)
            this.socket.subscribeForTrades(tickerToSwitch)
            // console.log(`${tickerToSwitch.toString()} removed from minute stream added to trade stream!`)
        } catch (error)
        {
            console.log(`Error removing ${tickerToSwitch.toString()} from minute stream to add to trade data stream 4`, error)
        }
    }
    removeTickerFromMinuteDataStream(tickerToRemove)
    {
        try
        {
            this.socket.unsubscribeFromBars(tickerToRemove)
            // console.log(`${tickerToRemove.toString()} removed from minute stream`)
        } catch (error)
        {
            console.log(`Error removing ${tickerToRemove.toString()} from minute Data Stream 5`, error)
        }
    }
    removeTickerFromMinuteAndTradeDataStream(tickerToRemove)
    {
        try
        {
            // this.socket.unsubscribeFromBars(tickerToRemove)
            this.socket.unsubscribeFromTrades(tickerToRemove)
            // console.log(`${tickerToRemove.toString()} removed from minute and trade stream `)
        } catch (error)
        {
            console.log(`Error removing ${tickerToRemove.toString()} from minute stream and from Trade Data Stream 6`, error)
        }
    }


}
module.exports = DataStream