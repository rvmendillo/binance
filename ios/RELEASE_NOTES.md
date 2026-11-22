Unsigned iPhone build of the Confluence ETH simulator, made automatically from this repository by GitHub Actions.

**It is a simulator only.** It never places orders and needs no Binance API key. Market data comes from Binance's public market-data API. Money is shown in Philippine pesos (switchable to US dollars in Settings).

### Install on your iPhone
iOS only installs apps signed for your device, so sign this IPA with your own Apple ID:

- **Sideloadly** (Windows or Mac): open `Confluence-unsigned.ipa`, enter your Apple ID, connect the iPhone by cable, press Start.
- **AltStore**: add the IPA from the My Apps tab.
- **Xcode** (Mac): open the project from `ios/` (see the README) and press Run.

Then on the iPhone: Settings > General > VPN & Device Management > trust your Apple ID; and on iOS 16 or later turn on Settings > Privacy & Security > Developer Mode.
With a free Apple ID the app must be re-signed every 7 days.

`ios-simulator.png` and `ios-simulator-dark.png` show this exact build running in the iOS simulator with live data.
