const mongoose = require('mongoose')

const watchSchema = new mongoose.Schema(
    {
        userId: { type: String },
        userMacroTickerId: { type: String },
        dailyEM: [Number],
        mostRecentDailyPosition: Number,
        weeklyEM: [Number],
        mostRecentWeeklyPosition: Number,
        monthly: [Number],
        mostRecentMonthlyPosition: Number,
        gammaFlipLine: Number,
        gammaFlipLineSideChanged: Boolean,
        aboveThisPriceAlert: [Number],
        belowThisPriceAlert: [Number],
    }, { _id: false })

const macroTickerWatchSchema = new mongoose.Schema({
    _id: { type: String, require: true },
    watchInfo: [watchSchema]
})

module.exports = mongoose.model('MacroTickerWatch', macroTickerWatchSchema)