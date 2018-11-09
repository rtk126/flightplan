const Searcher = require('../../Searcher')
const { cabins } = require('../../consts')

module.exports = class extends Searcher {
  async isLoggedIn (page) {
    await Promise.race([
      page.waitFor('li.btnLogoutArea', { visible: true }).catch(e => {}),
      page.waitFor('#accountNumber', { visible: true }).catch(e => {})
    ])

    const loggedIn = !!(await page.$('li.btnLogoutArea'))

    // If not fully logged in, log out (in case saved AMC number is different)
    if (loggedIn && await page.$('#password')) {
      await this.clickAndWait('li.btnLogoutArea > a')

      // Go back to flight search page
      await page.goto(this.config.searchURL, {waitUntil: 'networkidle0'})
      return false
    }

    return loggedIn
  }

  async login (page, credentials) {
    const [ username, password ] = credentials
    if (!username || !password) {
      throw new Searcher.Error(`Missing login credentials`)
    }

    // Enter username and password
    await page.click('#accountNumber')
    await this.clear('#accountNumber')
    await page.keyboard.type(username, { delay: 10 })
    await page.click('#password')
    await this.clear('#password')
    await page.keyboard.type(password, { delay: 10 })

    // Check remember box, and submit the form
    await page.click('#rememberLogin')
    await page.waitFor(250)
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.click('#amcMemberLogin')
    ])
    await this.settle()
  }

  validate (query) {
    // Prem. economy is not a supported cabin
    if (query.cabin === cabins.premium) {
      throw new Searcher.Error(`Unsupported cabin class: ${query.cabin}`)
    }
  }

  async search (page, query, results) {
    const { fromCity, toCity, quantity, oneWay } = query
    const departDate = query.departDateObject()
    const returnDate = oneWay ? departDate : query.returnDateObject()

    // Wait a little bit for the form to load
    await page.waitFor(1000)

    // Choose multiple cities / mixed classes
    await this.clickAndWait('li.lastChild.deselection')
    await page.waitFor(1000)

    // Weekday strings
    const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

    await this.fillForm({
      'requestedSegment:0:departureAirportCode:field': fromCity,
      'requestedSegment:1:arrivalAirportCode:field': fromCity,
      'requestedSegment:0:departureAirportCode:field_pctext': await this.airportName(fromCity),
      'requestedSegment:1:arrivalAirportCode:field_pctext': await this.airportName(fromCity),
      'requestedSegment:0:arrivalAirportCode:field': toCity,
      'requestedSegment:1:departureAirportCode:field': toCity,
      'requestedSegment:0:arrivalAirportCode:field_pctext': await this.airportName(toCity),
      'requestedSegment:1:departureAirportCode:field_pctext': await this.airportName(toCity),
      'requestedSegment:0:departureDate:field': departDate.toFormat('yyyyMMdd'),
      'requestedSegment:0:departureDate:field_pctext': departDate.toFormat('MM/dd/yyyy') + ` (${weekdays[departDate.weekday - 1]})`,
      'requestedSegment:1:departureDate:field': returnDate.toFormat('yyyyMMdd'),
      'requestedSegment:1:departureDate:field_pctext': returnDate.toFormat('MM/dd/yyyy') + ` (${weekdays[returnDate.weekday - 1]})`,
      'adult:count': quantity.toString(),
      'youngAdult:count': 0,
      'child:count': 0
    })

    // Use logged-in user's status to check award availability
    if (await page.$('#travelArranger:checked')) {
      await page.click('#travelArranger')
    }
    await page.waitFor(500)

    // Submit the form
    const response = await this.clickAndWait('input[value="Search"]')
    await this.settle()

    // Check response code
    this.checkResponse(response)

    // Save airports (need the names to map back to codes later)
    const airports = await page.evaluate(() => {
      const { airports } = Asw.AirportList
      return { airports }
    })
    await results.saveJSON(`airports`, airports)

    // Save outbound flights
    await this.save('outbound', results)

    // If roundtrip, select a flight and move to the next page
    if (!oneWay) {
      const radioButton = await page.$('i[role="radio"]')
      if (radioButton) {
        await radioButton.click()
        await this.waitBetween(3000, 6000)
        await this.clickAndWait('#nextButton')
        await this.settle()

        // Save inbound flights
        await this.save('inbound', results)
      }
    }
  }

  async save (name, results) {
    // Check for errors
    await this.checkPage()

    // Save the results
    await results.saveHTML(name)
    await results.screenshot(name)
  }

  async settle () {
    // Wait for spinner
    await this.monitor('div.loadingArea')
    await this.page.waitFor(1000)
  }

  async airportName (code) {
    return this.page.evaluate((code) => {
      const airport = Asw.AirportList.airports.find(x => x.code === code)
      return airport ? airport.name : ''
    }, code)
  }

  async checkPage () {
    const { page } = this

    if (await this.visible('.modalError')) {
      const msg = this.textContent('.modalError', '')
      if (msg.toLowerCase().includes('there are errors')) {
        throw new Searcher.Error(`The website encountered an error processing the request: ${msg}`)
      }
    }

    if (await page.$('#cmnContainer .messageArea')) {
      const msg = await this.textContent('#cmnContainer .messageArea', '')
      await page.click('#cmnContainer .buttonArea input')
      throw new Searcher.Error(`The website encountered an error processing the request: ${msg}`)
    }
  }
}