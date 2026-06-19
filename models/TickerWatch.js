const mongoose = require('mongoose')

const watchSchema = new mongoose.Schema(
    {
        userId: { type: String },
        plannedTradeId: { type: String },
        pricePoints: [Number],
        purpose: Number,
        tradeStatus: Number,

        aboveThisPriceAlert: [Number],
        belowThisPriceAlert: [
            {
                price: Number,
                alertId: { type: mongoose.Schema.Types.ObjectId, ref: "PriceAlert" },
                seen: Boolean,
                triggered: Boolean
            }
        ], includedInUserWatchList: { type: Boolean, default: false }
    }, { _id: false })

const tickerWatchSchema = new mongoose.Schema({
    _id: { type: String, require: true },
    watchInfo: [watchSchema]
})

module.exports = mongoose.model('TickerWatch', tickerWatchSchema)