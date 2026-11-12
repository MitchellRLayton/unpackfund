// Generated for the profitability prototype from the 2026-11-12 measurement.
// Source: docs/01-research/2026-11-11-sec-xbrl-fundamentals/evidence/part4/profitability_by_fund_2026-11-12.json

export type Measure = { median: number | null; mean: number | null; cov: number; n?: number };
export type Fund = {
  report_date: string;
  nav_b: number;
  fin_pct: number;
  roe: Measure;
  op: Measure;
  cbop: Measure;
  lev: Measure;
  supported: boolean;
};

export const FUNDS: Record<string, Fund> = {
  "AVUV": {
    "report_date": "2026-08-31",
    "nav_b": 31.17,
    "fin_pct": 27.6,
    "roe": {
      "median": 0.1012,
      "mean": 0.0758,
      "cov": 97.9,
      "n": 770
    },
    "op": {
      "median": 0.2714,
      "mean": 0.5485,
      "cov": 85.3,
      "n": 432
    },
    "cbop": {
      "median": 0.2246,
      "mean": 0.2663,
      "cov": 96.7,
      "n": 756
    },
    "lev": {
      "median": 0.5775,
      "mean": 0.58,
      "cov": 98.0
    },
    "supported": true
  },
  "DFSV": {
    "report_date": "2026-07-31",
    "nav_b": 8.21,
    "fin_pct": 28.4,
    "roe": {
      "median": 0.0735,
      "mean": 0.0513,
      "cov": 98.5,
      "n": 970
    },
    "op": {
      "median": 0.1926,
      "mean": 0.3929,
      "cov": 83.9,
      "n": 594
    },
    "cbop": {
      "median": 0.1481,
      "mean": 0.1683,
      "cov": 96.4,
      "n": 952
    },
    "lev": {
      "median": 0.5632,
      "mean": 0.5752,
      "cov": 98.6
    },
    "supported": true
  },
  "VB": {
    "report_date": "2026-06-30",
    "nav_b": 188.7,
    "fin_pct": 12.6,
    "roe": {
      "median": 0.0968,
      "mean": 0.1048,
      "cov": 96.9,
      "n": 1238
    },
    "op": {
      "median": 0.2732,
      "mean": 0.7062,
      "cov": 82.0,
      "n": 901
    },
    "cbop": {
      "median": 0.2119,
      "mean": 0.2789,
      "cov": 94.1,
      "n": 1208
    },
    "lev": {
      "median": 0.55,
      "mean": 0.5538,
      "cov": 99.5
    },
    "supported": true
  },
  "VBR": {
    "report_date": "2026-06-30",
    "nav_b": 67.8,
    "fin_pct": 17.3,
    "roe": {
      "median": 0.0946,
      "mean": 0.117,
      "cov": 98.3,
      "n": 806
    },
    "op": {
      "median": 0.2477,
      "mean": 0.7871,
      "cov": 78.0,
      "n": 543
    },
    "cbop": {
      "median": 0.2066,
      "mean": 0.2878,
      "cov": 95.0,
      "n": 783
    },
    "lev": {
      "median": 0.5906,
      "mean": 0.6017,
      "cov": 99.5
    },
    "supported": true
  },
  "IJR": {
    "report_date": "2026-06-30",
    "nav_b": 111.32,
    "fin_pct": 16.5,
    "roe": {
      "median": 0.0883,
      "mean": 0.0765,
      "cov": 96.0,
      "n": 581
    },
    "op": {
      "median": 0.2275,
      "mean": 0.5338,
      "cov": 85.1,
      "n": 417
    },
    "cbop": {
      "median": 0.1775,
      "mean": 0.2625,
      "cov": 93.1,
      "n": 570
    },
    "lev": {
      "median": 0.5399,
      "mean": 0.5573,
      "cov": 99.4
    },
    "supported": true
  },
  "XSMO": {
    "report_date": "2026-07-31",
    "nav_b": 3.03,
    "fin_pct": 13.6,
    "roe": {
      "median": 0.1053,
      "mean": 0.0875,
      "cov": 92.5,
      "n": 102
    },
    "op": {
      "median": 0.2141,
      "mean": -301.1754,
      "cov": 76.9,
      "n": 70
    },
    "cbop": {
      "median": 0.2046,
      "mean": 0.3561,
      "cov": 90.1,
      "n": 100
    },
    "lev": {
      "median": 0.5533,
      "mean": 0.5812,
      "cov": 99.0
    },
    "supported": true
  },
  "MTUM": {
    "report_date": "2026-07-31",
    "nav_b": 25.32,
    "fin_pct": 5.4,
    "roe": {
      "median": 0.2592,
      "mean": 0.2958,
      "cov": 94.8,
      "n": 122
    },
    "op": {
      "median": 0.4477,
      "mean": 0.5045,
      "cov": 88.6,
      "n": 93
    },
    "cbop": {
      "median": 0.3446,
      "mean": 0.3728,
      "cov": 93.9,
      "n": 118
    },
    "lev": {
      "median": 0.4785,
      "mean": 0.5144,
      "cov": 96.2
    },
    "supported": true
  },
  "QMOM": {
    "report_date": "2026-06-30",
    "nav_b": 0.44,
    "fin_pct": 0.0,
    "roe": {
      "median": 0.1056,
      "mean": 0.2523,
      "cov": 94.0,
      "n": 48
    },
    "op": {
      "median": 0.2844,
      "mean": 0.8875,
      "cov": 78.0,
      "n": 40
    },
    "cbop": {
      "median": 0.2374,
      "mean": 0.4405,
      "cov": 92.0,
      "n": 47
    },
    "lev": {
      "median": 0.5666,
      "mean": 0.5558,
      "cov": 98.0
    },
    "supported": true
  },
  "VTI": {
    "report_date": "2026-06-30",
    "nav_b": 2297.84,
    "fin_pct": 10.9,
    "roe": {
      "median": 0.2534,
      "mean": 0.3423,
      "cov": 96.0,
      "n": 3211
    },
    "op": {
      "median": 0.5599,
      "mean": 0.8111,
      "cov": 88.4,
      "n": 2120
    },
    "cbop": {
      "median": 0.3594,
      "mean": 0.451,
      "cov": 95.2,
      "n": 3149
    },
    "lev": {
      "median": 0.516,
      "mean": 0.5419,
      "cov": 98.9
    },
    "supported": true
  },
  "VOO": {
    "report_date": "2026-06-30",
    "nav_b": 1671.23,
    "fin_pct": 10.4,
    "roe": {
      "median": 0.271,
      "mean": 0.4166,
      "cov": 96.1,
      "n": 482
    },
    "op": {
      "median": 0.6184,
      "mean": 0.8404,
      "cov": 89.3,
      "n": 339
    },
    "cbop": {
      "median": 0.375,
      "mean": 0.5261,
      "cov": 95.6,
      "n": 471
    },
    "lev": {
      "median": 0.5078,
      "mean": 0.5377,
      "cov": 99.0
    },
    "supported": true
  },
  "VEA": {
    "report_date": "2026-06-30",
    "nav_b": 316.42,
    "fin_pct": 19.7,
    "roe": {
      "median": 0.088,
      "mean": 0.0965,
      "cov": 11.3,
      "n": 114
    },
    "op": {
      "median": 0.2869,
      "mean": 0.6537,
      "cov": 11.2,
      "n": 84
    },
    "cbop": {
      "median": 0.2165,
      "mean": 0.2387,
      "cov": 10.8,
      "n": 110
    },
    "lev": {
      "median": 0.5649,
      "mean": 0.525,
      "cov": 11.5
    },
    "supported": false
  },
  "AVDV": {
    "report_date": "2026-08-31",
    "nav_b": 20.5,
    "fin_pct": 0.8,
    "roe": {
      "median": 0.124,
      "mean": 0.1251,
      "cov": 18.1,
      "n": 45
    },
    "op": {
      "median": 0.3797,
      "mean": 1.0866,
      "cov": 15.4,
      "n": 31
    },
    "cbop": {
      "median": 0.1717,
      "mean": 0.1985,
      "cov": 17.5,
      "n": 42
    },
    "lev": {
      "median": 0.5195,
      "mean": 4.7001,
      "cov": 19.2
    },
    "supported": false
  }
};

export const ORDER = ["AVUV","DFSV","VB","VBR","IJR","XSMO","MTUM","QMOM","VTI","VOO","VEA","AVDV"];
