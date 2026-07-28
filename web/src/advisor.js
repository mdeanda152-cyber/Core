/* Capture -- growth advisor.
 *
 * A conversational front end over scvr/market.py's engine. It parses what you
 * asked, runs the scenario, and narrates the result; it never invents a
 * number. Everything it quotes comes back from CaptureMarket, which is parity
 * tested against the Python.
 *
 * There is no language model here. Intent matching is keyword and entity
 * based, which means the answers are reproducible: the same question against
 * the same firm model always returns the same figures.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) { module.exports = api; }
  else { root.CaptureAdvisor = api; }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var M = null;   // CaptureMarket, injected

  function init(marketApi) { M = marketApi; }

  var STOP_WORDS = [
    "should", "i", "we", "open", "in", "at", "a", "an", "the", "is", "it", "go",
    "into", "to", "for", "good", "bad", "idea", "decision", "market", "markets",
    "about", "how", "big", "what", "whats", "if", "with", "and", "or", "of", "my",
    "me", "you", "expand", "expansion", "office", "city", "cities", "area", "areas",
    "next", "start", "starting", "launch", "worth", "does", "do", "make", "sense",
    "much", "many", "there", "here", "than", "then", "vs", "versus", "compare",
    "best", "top", "where", "which", "consultants", "consultant", "people", "heads",
    "trajectory", "breakeven", "break", "even", "assumptions", "help", "would",
    "could", "can", "will", "be", "are", "was", "this", "that", "on", "from"
  ];

  var INTENTS = [
    { id: "help", patterns: ["help", "what can you", "how does this work", "what do you do"] },
    { id: "assumptions", patterns: ["assumption", "how do you know", "come from", "where did",
                                    "source", "made up", "real data", "how did you get",
                                    "based on", "is this real", "trust these"] },
    { id: "rank", patterns: ["best market", "top market", "where should", "which area",
                             "which market", "which cit", "rank", "best cit", "good areas",
                             "what areas", "where to go", "where next"] },
    { id: "compare", patterns: [" vs ", "versus", "compare", "or "] },
    { id: "trajectory", patterns: ["trajectory", "break even", "breakeven", "when do i",
                                   "how long until", "payback", "profitable"] },
    { id: "size", patterns: ["how big", "how many", "market size", "size of", "what is there",
                             "whats there", "demand in", "demand for"] },
    { id: "decision", patterns: ["should i", "should we", "good idea", "good decision",
                                 "worth it", "make sense", "open in", "expand"] }
  ];

  function normalise(text) {
    return String(text || "").toLowerCase().replace(/[?!,.;:]/g, " ").replace(/\s+/g, " ").trim();
  }

  function detectIntent(text) {
    var lowered = " " + normalise(text) + " ";
    for (var i = 0; i < INTENTS.length; i++) {
      for (var j = 0; j < INTENTS[i].patterns.length; j++) {
        if (lowered.indexOf(INTENTS[i].patterns[j]) !== -1) return INTENTS[i].id;
      }
    }
    return null;
  }

  /* Pull metro names out of free text by trying the longest word runs first,
   * so "new york" beats "york" and "san bernardino" is not read as "san". */
  function detectMetros(text) {
    var words = normalise(text).split(" ").filter(function (w) {
      return w && STOP_WORDS.indexOf(w) === -1 && !/^\d+$/.test(w);
    });
    var found = [];
    var used = {};
    for (var size = Math.min(3, words.length); size >= 1; size--) {
      for (var start = 0; start + size <= words.length; start++) {
        var indexes = [];
        for (var k = 0; k < size; k++) indexes.push(start + k);
        if (indexes.some(function (idx) { return used[idx]; })) continue;
        var phrase = words.slice(start, start + size).join(" ");
        if (phrase.length < 3) continue;
        var metro = M.findMetro(phrase);
        if (metro && found.indexOf(metro) === -1) {
          found.push(metro);
          indexes.forEach(function (idx) { used[idx] = true; });
        }
      }
    }
    return found;
  }

  function detectNumber(text, keywords) {
    var lowered = normalise(text);
    for (var i = 0; i < keywords.length; i++) {
      var match = lowered.match(new RegExp("(\\d+(?:\\.\\d+)?)\\s*" + keywords[i]));
      if (match) return Number(match[1]);
      match = lowered.match(new RegExp(keywords[i] + "\\s*(?:of|=|:)?\\s*(\\d+(?:\\.\\d+)?)"));
      if (match) return Number(match[1]);
    }
    return null;
  }

  function detectSubVertical(text) {
    var lowered = normalise(text);
    var map = {
      "3pl": "3pl", "third party": "3pl", "logistics": "3pl",
      "cold chain": "cold_chain", "cold": "cold_chain", "food": "cold_chain",
      "distribution": "industrial_distribution", "wholesale": "industrial_distribution",
      "retail": "retail_dc", "manufactur": "manufacturing"
    };
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      if (lowered.indexOf(keys[i]) !== -1) return map[keys[i]];
    }
    return null;
  }

  /**
   * Parse a question into everything the engine needs.
   * Returns a plan the UI can execute and render.
   */
  function interpret(text, context) {
    var metros = detectMetros(text);
    var intent = detectIntent(text);
    var consultants = detectNumber(text, ["consultants?", "heads?", "people", "staff"]);
    var horizon = detectNumber(text, ["months?", "years?"]);
    var loweredText = normalise(text);
    if (horizon && loweredText.indexOf("year") !== -1) horizon = horizon * 12;
    var subVertical = detectSubVertical(text) || (context && context.sub_vertical) || null;

    if (!intent) {
      intent = metros.length >= 2 ? "compare" : (metros.length === 1 ? "decision" : "help");
    }
    if (intent === "compare" && metros.length < 2) {
      intent = metros.length === 1 ? "decision" : "rank";
    }
    var usedContext = false;
    if ((intent === "decision" || intent === "size" || intent === "trajectory") && !metros.length) {
      var carried = (context && context.lastMetros) || [];
      if (carried.length) {
        metros = carried.map(function (id) { return M.findMetro(id); }).filter(Boolean);
        usedContext = metros.length > 0;
      } else {
        intent = "rank";
      }
    }

    return {
      intent: intent,
      metros: metros,
      consultants: consultants,
      horizon_months: horizon && horizon >= 12 && horizon <= 120 ? Math.round(horizon) : null,
      sub_vertical: subVertical,
      used_context: usedContext,
      // Words long enough to be a place name that matched nothing we know.
      unknown_places: unknownPlaces(text),
      unmatched: metros.length === 0 && /[a-z]{4,}/.test(loweredText)
    };
  }

  /* Words that look like a place but match no metro. Used to admit ignorance
   * rather than quietly answering about somewhere else. */
  function unknownPlaces(text) {
    return normalise(text).split(" ").filter(function (word) {
      return word.length > 3 &&
             STOP_WORDS.indexOf(word) === -1 &&
             !/^\d+$/.test(word) &&
             !M.findMetro(word);
    }).filter(function (word) {
      return ["month", "months", "year", "years", "market", "markets", "revenue",
              "profit", "cash", "team", "firm", "practice", "client", "clients",
              "chain", "cold", "food", "retail", "wholesale", "logistics",
              "numbers", "data", "come", "from", "there", "these", "those",
              "money", "much", "long", "take", "into", "when", "does"].indexOf(word) === -1;
    });
  }

  function scenarioFor(plan, firm, metroIds) {
    var inputs = {
      markets: metroIds,
      sub_vertical: plan.sub_vertical || null
    };
    if (plan.consultants) inputs.starting_consultants = plan.consultants;
    if (plan.horizon_months) inputs.horizon_months = plan.horizon_months;
    return M.runScenario(firm, inputs);
  }

  return {
    init: init,
    interpret: interpret,
    scenarioFor: scenarioFor,
    detectMetros: detectMetros,
    detectIntent: detectIntent,
    detectNumber: detectNumber,
    detectSubVertical: detectSubVertical,
    unknownPlaces: unknownPlaces,
    normalise: normalise
  };
});
