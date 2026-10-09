# India locations

`india-locations.json` is an offline India-only derivative of
[Countries States Cities Database](https://github.com/dr5hn/countries-states-cities-database),
by dr5hn and contributors. Retrieved 2026-10-02.

Sources:
- https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/states.json
- https://github.com/dr5hn/countries-states-cities-database/releases/latest/download/json-cities.json.gz

The derived database is available under the Open Database License (ODbL 1.0);
see `locations-LICENSE.txt`. Retain attribution and this license when distributing it.

Transformation: filter both sources to country_code IN, join cities.state_id
to states.id, retain state and city names, remove duplicate city names within
each state, and sort alphabetically. All 36 state/union territory entries are
included. City/town coverage is provided by the source and is not a guarantee
that every village, locality, spelling variant or newly renamed city is listed.
The bundled data requires no runtime API calls or credentials.
