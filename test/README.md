Optional: this script re-validates the payment/balance/due-date math
against a real local Postgres database. Not required to deploy — just
here if you ever want to sanity-check changes.

  npm install pg --save-dev
  node test/logic_test.js
