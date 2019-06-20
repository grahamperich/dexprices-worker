const tokenAbi = require('human-standard-token-abi')
const ethers = require('ethers')
const { tokenSymbolResolver } = require('../tokenSymbolResolver.js')
const { UNISWAP_FACTORY_ABI, UNISWAP_FACTORY_ADDRESS } = require('../constants.js')

const { utils } = ethers

module.exports = class Uniswap {
  constructor() {
    this.ethProvider = ethers.getDefaultProvider('homestead')
    this.factoryContract = new ethers.Contract(UNISWAP_FACTORY_ADDRESS, UNISWAP_FACTORY_ABI, this.ethProvider)
    this.name = 'Uniswap'
  }

  // fetch all supported tokens traded on Uniswap
  async getExchangeLiquidityByAddress(symbol, address, decimals) {
    // Although TUSD has migrated to a new contract some time ago (0x0000000000085d4780b73119b644ae5ecd22b376),
    // it is still accessible under the previous address (0x8dd5fbCe2F6a956C3022bA3663759011Dd51e73E)
    // and it's actually the previous address that the Uniswap reserve exists for.
    let tokenAddress
    if (address.toUpperCase() === '0x0000000000085d4780b73119b644ae5ecd22b376'.toUpperCase()) {
      tokenAddress = '0x8dd5fbCe2F6a956C3022bA3663759011Dd51e73E'
    } else {
      tokenAddress = address
    }

    const erc20Contract = await new ethers.Contract(tokenAddress, tokenAbi, this.ethProvider)
    const exchangeAddress = await this.factoryContract.getExchange(tokenAddress)

    if (exchangeAddress === '0x0000000000000000000000000000000000000000') {
      // token does not yet have an exchange on uniswap
      throw new Error(`no Uniswap market exists for ${symbol}`)
    }

    const ethReserve = await this.ethProvider.getBalance(exchangeAddress)
    const erc20Reserve = await erc20Contract.balanceOf(exchangeAddress)

    const ethAmount = utils.formatUnits(utils.bigNumberify(ethReserve.toString(10)), 18)
    const tokenAmount = utils.formatUnits(utils.bigNumberify(erc20Reserve.toString(10)), decimals)
    return { ethAmount, tokenAmount }
  }

  static getBuyRate(tokenAmountBought, inputReserve, outputReserve) {
    const numerator = tokenAmountBought * inputReserve * 1000
    const denominator = (outputReserve - tokenAmountBought) * 997
    return numerator / (denominator + 1)
  }

  static getSellRate(tokenAmountSold, soldReserve, boughtReserve) {
    const numerator = tokenAmountSold * boughtReserve * 997
    const denominator = soldReserve * 1000 + tokenAmountSold * 997
    return numerator / denominator
  }

  // compute the average token price based on DEX liquidity and desired token amount
  async computePrice(symbol, desiredAmount, isSell) {
    let result = {}
    try {
      const { addr, decimals } = await tokenSymbolResolver(symbol)
      const { ethAmount, tokenAmount } = await this.getExchangeLiquidityByAddress(symbol, addr, decimals)

      // Any BNB sent to Uniswap will be lost forever
      // https://twitter.com/UniswapExchange/status/1072286773554876416
      // https://medium.com/coinmonks/missing-return-value-bug-at-least-130-tokens-affected-d67bf08521ca
      if (symbol === 'BNB') {
        throw new Error('BNB can not be traded on Uniswap due to a bug in the token code')
      }
 
      if (parseFloat(ethAmount) === 0 || parseFloat(tokenAmount) === 0) {
        throw new Error(`no liquidity available for ${symbol}`)
      }
      let totalPrice = null
      if (isSell) {
        totalPrice = Uniswap.getSellRate(desiredAmount, tokenAmount, ethAmount)
      } else {
        totalPrice = Uniswap.getBuyRate(desiredAmount, ethAmount, tokenAmount)
      }

      if (totalPrice <= 0) {
        throw new Error(`not enough liquidity. only ${tokenAmount} ${symbol} available and ${ethAmount} ETH`)
      }

      const avgPrice = totalPrice / desiredAmount

      result = {
        exchangeName: this.name,
        totalPrice,
        tokenAmount: desiredAmount,
        tokenSymbol: symbol,
        avgPrice,
        timestamp: Date.now(),
        error: null,
      }
    } catch (e) {
      result = {
        exchangeName: this.name,
        timestamp: Date.now(),
        error: e.message,
        tokenSymbol: symbol,
        tokenAmount: parseFloat(desiredAmount),
      }
    }
    return { [this.name]: result }
  }
}
