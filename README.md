# stock_viewer
A web app that allows you to see real time stock data and stock statistics to help YOU when buying stocks. 


stock_finder.py

You need a FREE Tiingo API token (instant signup at https://www.tiingo.com).
Set it via the TIINGO_API_KEY env var (TIINGO_TOKEN also accepted):

                    (sorry you cant steal mine 🥺)
    export TIINGO_API_KEY=YOUR_API_KEY  
    python3 stock_finder.py

A chart view costs a few requests (history + live quote + a 52-week lookup the
first time a symbol is seen); responses are cached in-memory so flipping ranges
on the same symbol stays cheap.

Endpoints
---------
GET /                         -> display.html
GET /<file>                   -> static file from this directory
GET /api/search?q=apple       -> symbol lookup / autocomplete
GET /api/chart?symbol=AAPL&range=1mo&interval=1d
                              -> normalized price history + live quote

Run:
    python3 stock_finder.py            # http://localhost:8000
    python3 stock_finder.py 9001       # custom port
