const Alpaca = require('@alpacahq/alpaca-trade-api')

class DataStream
{
    constructor({ apiKey, secretKey })
    {
        this.alpaca = new Alpaca({ keyId: apiKey, secretKey, })
        const socket = this.alpaca.data_stream_v2;

        this.socket = socket

        this.socket.onConnect(function () { console.log("Connected To Alpaca Data Stream"); });

        this.socket.onError((err) =>
        {
            console.log(err);
            // setTimeout(() =>
            // {
            //     this.socket.connect()
            // }, 5000)
        });

        this.socket.onStateChange((state) => { console.log(state); });

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
            console.log(`Error adding ${tickerToAdd.toString()} to Trade Data Stream 1`, error)
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







    removeTickerFromAlpacaDataStream(tickerToRemove)
    {
        try
        {
            this.socket.subscribeForTrades(tickerToRemove)
            console.log(`${tickerToRemove.toString()} removed from trade stream.`)
        } catch (error)
        {
            console.log(`Error removing ${tickerToRemove.toString()} from Trade Data Stream 3`, error)
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