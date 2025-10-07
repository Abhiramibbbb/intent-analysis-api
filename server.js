require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qdrantService = require('./qdrant-service');

const app = express();
const PORT = process.env.PORT || 3000;
const SIMILARITY_THRESHOLD = 0.5;

// In-memory logs storage
const logs = [];

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/docs', express.static('docs'));  // ← NEW LINE ADDED

// Dictionaries for Clear matches (primary words and synonyms)
const INTENT_DICTIONARY = {
  'menu': {
    primary: ['i would like to'],
    synonyms: ['i need to', 'i want to', 'i wish to']
  },
  'help': {
    primary: ['how do i'],
    synonyms: ['show me how', 'how to']
  }
};

const ACTION_DICTIONARY = {
  'create': {
    primary: ['create', 'add'],
    synonyms: ['enter', 'generate', 'include', 'attach', 'insert']
  },
  'modify': {
    primary: ['modify', 'update'],
    synonyms: ['change', 'edit']
  },
  'search for': {
    primary: ['search for', 'search'],
    synonyms: ['retrieve', 'check']
  },
  'delete record': {
    primary: ['delete record', 'delete'],
    synonyms: ['remove', 'discard']
  }
};

const PROCESS_DICTIONARY = {
  'objective': {
    primary: ['objective'],
    synonyms: ['goal']
  },
  'Key Result': {
    primary: ['Key Result'],
    synonyms: ['KPI']
  },
  'Initiative': {
    primary: ['Initiative'],
    synonyms: ['Action Item']
  },
  'Review Meeting': {
    primary: ['Review Meeting'],
    synonyms: ['Meeting']
  },
  'Key Result Checkin': {
    primary: ['Key Result Checkin'],
    synonyms: ['Checkin']
  }
};

const FILTER_NAME_DICTIONARY = {
  'due': { primary: ['due', 'deadline'], synonyms: ['due date'] },
  'priority': { primary: ['priority'], synonyms: ['importance'] },
  'status': { primary: ['status'], synonyms: ['state'] },
  'assigned': { primary: ['assigned', 'assigned to'], synonyms: ['owner'] },
  'quarter': { primary: ['quarter', 'q'], synonyms: [] }
};

const FILTER_OPERATOR_DICTIONARY = {
  'equals': { primary: ['=', 'equals', 'is'], synonyms: ['equal to'] },
  'greater than': { primary: ['>', 'greater than'], synonyms: ['more than'] },
  'less than': { primary: ['<', 'less than'], synonyms: ['below'] }
};

const FILTER_VALUE_DICTIONARY = {
  'date': { primary: ['today', 'tomorrow', 'yesterday'], synonyms: [] },
  'priority': { primary: ['high', 'low', 'medium'], synonyms: [] },
  'status': { primary: ['pending', 'completed'], synonyms: ['done'] },
  'quarter': { primary: ['q1', 'q2', 'q3', 'q4', 'quarter 1', 'quarter 2', 'quarter 3', 'quarter 4', '1', '2', '3', '4'], synonyms: [] }
};

// NEW: Process-to-Reference Document Mapping for Help Intent Redirect
const PROCESS_REFERENCE_MAPPING = {
  'objective': '/docs/objective-help.html',
  'Key Result': '/docs/key-result-help.html',
  'Initiative': '/docs/initiative-help.html',
  'Review Meeting': '/docs/review-meeting-help.html',
  'Key Result Checkin': '/docs/key-result-checkin-help.html'
};

// Phrase dictionaries for Adequate Clarity matches
const INTENT_PHRASE_DICTIONARY = {
  'menu': ['looking to manage', 'trying to access', 'planning to work on'],
  'help': ['can you explain', 'need assistance with', 'how can i']
};

const ACTION_PHRASE_DICTIONARY = {
  'create': ['set up a new', 'make a new', 'start a'],
  'modify': ['adjust the', 'revise the', 'alter the'],
  'search for': ['look for', 'find the', 'query for'],
  'delete record': ['get rid of', 'remove the', 'erase the']
};

const PROCESS_PHRASE_DICTIONARY = {
  'objective': ['target to achieve', 'plan for', 'aim to complete'],
  'Key Result': ['performance metric', 'result to track', 'key performance indicator'],
  'Initiative': ['project to start', 'task to undertake', 'action to take'],
  'Review Meeting': ['team meeting', 'discussion session', 'review session'],
  'Key Result Checkin': ['progress check', 'status update', 'check-in meeting']
};

const FILTER_NAME_PHRASE_DICTIONARY = {
  'due': ['when it is due', 'due by', 'completion date'],
  'priority': ['level of urgency', 'importance level', 'priority of'],
  'status': ['current state', 'progress status', 'condition of'],
  'assigned': ['who is responsible', 'assigned person', 'task owner']
};

const FILTER_OPERATOR_PHRASE_DICTIONARY = {
  'equals': ['same as', 'matches', 'is exactly'],
  'greater than': ['exceeds', 'higher than', 'above'],
  'less than': ['under', 'lower than', 'lesser than']
};

const FILTER_VALUE_PHRASE_DICTIONARY = {
  'date': ['this week', 'next week', 'last week'],
  'priority': ['urgent', 'normal', 'minor'],
  'status': ['in progress', 'open', 'closed']
};

// Enhanced filter detection patterns
const FILTER_PATTERNS = [
  /(\w+)\s*(=|\bequals\b|\bis\b|\bequal to\b)\s*([^\s,]+)/gi,
  /(\w+)\s*(>|\bgreater than\b|\bmore than\b|\babove\b)\s*([^\s,]+)/gi,
  /(\w+)\s*(<|\bless than\b|\bbelow\b|\bunder\b)\s*([^\s,]+)/gi,
  /(due|priority|status|assigned)\s+(today|tomorrow|yesterday|high|low|medium|pending|completed|[^\s,]+)/gi,
  /where\s+(\w+)\s*(=|>|<|\bequals\b|\bis\b)\s*([^\s,]+)/gi,
  /(quarter|q)\s*(=|\bequals\b|\bis\b|\bequal to\b)\s*(q?[1-4])/gi,
  /for\s+(quarter|q)\s*(q?[1-4])/gi
];

// Calculate similarity using Qdrant with proper scoring
async function calculateLLMSimilarity(userInput, category, options) {
  const categoryMap = {
    'intent': 'intent',
    'process': 'process',
    'action': 'action',
    'filter name': 'filter_name',
    'filter operator': 'filter_operator',
    'filter value': 'filter_value'
  };

  const qdrantCategory = categoryMap[category] || category;

  // Extract category-specific text for better semantic matching
  let searchText = userInput;
  
  if (category === 'intent') {
    // Extract just the intent phrase (beginning of sentence before action verbs)
    const actionMatch = userInput.match(/^(.*?)\s+(create|add|modify|update|edit|search|find|delete|remove|view|show)/i);
    if (actionMatch) {
      searchText = actionMatch[1].trim();
    }
  } else if (category === 'action') {
    // Extract action word and immediate context
    const actionMatch = userInput.match(/(create|add|modify|update|edit|search|find|delete|remove|view|show)(\s+\w+)?/i);
    if (actionMatch) {
      searchText = actionMatch[0];
    }
  } else if (category === 'process') {
    // Extract process noun phrase (after action verb)
    const processMatch = userInput.match(/(?:create|add|modify|update|edit|search|find|delete|remove|view|show)\s+(?:a|an|the|my)?\s*(\w+(?:\s+\w+)?)/i);
    if (processMatch) {
      searchText = processMatch[1];
    }
  }

  try {
    // Search with extracted text for better semantic matching
    const result = await qdrantService.searchSimilar(
      searchText,
      qdrantCategory,
      10,
      SIMILARITY_THRESHOLD
    );

    console.log(`Qdrant result for "${searchText}" in ${category}:`, result);

    if (result.match && result.score >= SIMILARITY_THRESHOLD) {
      console.log(`✓ Qdrant match found for ${category}: ${result.match} (score: ${result.score.toFixed(3)})`);
      return { match: result.match, score: result.score };
    }

    console.log(`✗ Qdrant score ${result.score.toFixed(3)} below threshold ${SIMILARITY_THRESHOLD} for ${category}`);
  } catch (error) {
    console.error(`Qdrant search error for ${category}:`, error);
  }

  // Programmatic fallback
  console.log(`Using programmatic fallback for ${category}`);
  return programmaticFallback(userInput, category);
}

// Programmatic fallback function
function programmaticFallback(userInput, category) {
  let maxScore = 0;
  let bestMatch = null;
  const input = userInput.toLowerCase().trim();

  const checkPatterns = (dict, phraseDict) => {
    // Check dictionary patterns
    for (const [key, patterns] of Object.entries(dict)) {
      for (const pattern of [...patterns.primary, ...patterns.synonyms]) {
        if (input.includes(pattern.toLowerCase())) {
          const score = patterns.primary.includes(pattern) ? 0.9 : 0.85;
          if (score > maxScore) {
            maxScore = score;
            bestMatch = key;
          }
        }
        if (maxScore >= 0.5) break;
      }
    }

    // Check phrase dictionary
    if (maxScore < 0.5 && phraseDict) {
      for (const [key, phrases] of Object.entries(phraseDict)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            const score = 0.7;
            if (score > maxScore) {
              maxScore = score;
              bestMatch = key;
            }
          }
          if (maxScore >= 0.5) break;
        }
      }
    }
  };

  if (category === 'intent') {
    checkPatterns(INTENT_DICTIONARY, INTENT_PHRASE_DICTIONARY);
  } else if (category === 'process') {
    checkPatterns(PROCESS_DICTIONARY, PROCESS_PHRASE_DICTIONARY);
  } else if (category === 'action') {
    checkPatterns(ACTION_DICTIONARY, ACTION_PHRASE_DICTIONARY);
  } else if (category === 'filter name') {
    checkPatterns(FILTER_NAME_DICTIONARY, FILTER_NAME_PHRASE_DICTIONARY);
  } else if (category === 'filter operator') {
    checkPatterns(FILTER_OPERATOR_DICTIONARY, FILTER_OPERATOR_PHRASE_DICTIONARY);
  } else if (category === 'filter value') {
    checkPatterns(FILTER_VALUE_DICTIONARY, FILTER_VALUE_PHRASE_DICTIONARY);
  }

  return { match: bestMatch, score: maxScore };
}

// Analysis class implementing your pseudo code
class ConversationAnalyzer {
  constructor() {
    this.reset();
  }

  reset() {
    this.analysis = {
      userInput: '',
      intent: { status: 'Not Found', value: '', reply: '' },
      process: { status: 'Not Found', value: '', reply: '' },
      action: { status: 'Not Found', value: '', reply: '' },
      filters: { status: 'Not Found', value: [], reply: '' },
      finalAnalysis: '',
      suggested_action: '',
      example_query: '',
      proceed_button: false,
      redirect_flag: false,
      redirect_url: null,
      step1_reply: '',
      step2_reply: '',
      step3_reply: '',
      step4_reply: ''
    };
  }

  // Step 1: Intent Conclusion
  async step1_intentConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let intentFound = false;

    // 1.1 Programmatic Check for Clear matches (primary or synonyms)
    for (const [intent, patterns] of Object.entries(INTENT_DICTIONARY)) {
      for (const pattern of [...patterns.primary, ...patterns.synonyms]) {
        if (input.includes(pattern)) {
          this.analysis.intent = {
            status: 'Clear',
            value: intent,
            reply: 'Your intent is clear.'
          };
          this.analysis.step1_reply = 'Your intent is clear.';
          intentFound = true;
          break;
        }
      }
      if (intentFound) break;
    }

    // 1.2 Programmatic Check for Adequate Clarity (phrases)
    if (!intentFound) {
      for (const [intent, phrases] of Object.entries(INTENT_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.intent = {
              status: 'Adequate Clarity',
              value: intent,
              reply: 'Your intent seems somewhat clear.'
            };
            this.analysis.step1_reply = 'Your intent seems somewhat clear.';
            intentFound = true;
            break;
          }
        }
        if (intentFound) break;
      }
    }

    // 1.3 Qdrant Check for intent similarity
    if (!intentFound) {
      const similarity = await calculateLLMSimilarity(input, 'intent', Object.keys(INTENT_DICTIONARY));
      if (similarity.score >= SIMILARITY_THRESHOLD) {
        this.analysis.intent = {
          status: 'Adequate Clarity',
          value: similarity.match,
          reply: 'Your intent seems somewhat clear.'
        };
        this.analysis.step1_reply = 'Your intent seems somewhat clear.';
        intentFound = true;
      }
    }

    // 1.4 No intent detected
    if (!intentFound) {
      if (this.hasAnyKeywords(input)) {
        this.analysis.intent = {
          status: 'Not Clear',
          value: '',
          reply: 'Unable to determine your intent.'
        };
        this.analysis.step1_reply = 'Unable to determine your intent.';
      } else {
        this.analysis.intent = {
          status: 'Not Found',
          value: '',
          reply: 'No intent detected.'
        };
        this.analysis.step1_reply = 'No intent detected.';
      }
    }
  }

  // Step 2: Process Conclusion
  async step2_processConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let processFound = false;

    // 2.1 Programmatic Check for Clear matches
    for (const [process, patterns] of Object.entries(PROCESS_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input === keyword.toLowerCase() || input.includes(keyword.toLowerCase())) {
          this.analysis.process = {
            status: 'Clear',
            value: process,
            reply: `Detected process is clear: ${process}`
          };
          this.analysis.step2_reply = `Detected process is clear: ${process}`;
          processFound = true;
          break;
        }
      }
      if (processFound) break;
    }

    // 2.2 Programmatic Check for Adequate Clarity
    if (!processFound) {
      for (const [process, phrases] of Object.entries(PROCESS_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.process = {
              status: 'Adequate Clarity',
              value: process,
              reply: `Detected process is somewhat clear: ${process}`
            };
            this.analysis.step2_reply = `Detected process is somewhat clear: ${process}`;
            processFound = true;
            break;
          }
        }
        if (processFound) break;
      }
    }

    // 2.3 Qdrant Check
    if (!processFound) {
      const similarity = await calculateLLMSimilarity(input, 'process', Object.keys(PROCESS_DICTIONARY));
      if (similarity.score >= SIMILARITY_THRESHOLD) {
        this.analysis.process = {
          status: 'Adequate Clarity',
          value: similarity.match,
          reply: `Detected process is somewhat clear: ${similarity.match}`
        };
        this.analysis.step2_reply = `Detected process is somewhat clear: ${similarity.match}`;
        processFound = true;
      }
    }

    // 2.4 No process detected
    if (!processFound) {
      if (this.hasAnyKeywords(input)) {
        this.analysis.process = {
          status: 'Not Clear',
          value: '',
          reply: 'Unable to determine the process.'
        };
        this.analysis.step2_reply = 'Unable to determine the process.';
      } else {
        this.analysis.process = {
          status: 'Not Found',
          value: '',
          reply: 'No process detected.'
        };
        this.analysis.step2_reply = 'No process detected.';
      }
    }
  }

  // Step 2.5: Help Intent Redirect Check (NEW)
  step2_5_helpIntentRedirectCheck() {
    const intentOk = ['Clear', 'Adequate Clarity'].includes(this.analysis.intent.status);
    const processOk = ['Clear', 'Adequate Clarity'].includes(this.analysis.process.status);
    const isHelpIntent = this.analysis.intent.value === 'help';

    if (isHelpIntent && intentOk && processOk) {
      const detectedProcess = this.analysis.process.value;
      const redirectUrl = PROCESS_REFERENCE_MAPPING[detectedProcess];

      if (redirectUrl) {
        this.analysis.finalAnalysis = `Redirecting you to the help documentation for ${detectedProcess}.`;
        this.analysis.proceed_button = false;
        this.analysis.redirect_flag = true;
        this.analysis.redirect_url = redirectUrl;
        this.analysis.suggested_action = '';
        this.analysis.example_query = '';
        return true; // Redirect will occur
      }
    }
    return false; // No redirect, continue to Step 3
  }

  // Step 3: Action Conclusion
  async step3_actionConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let actionFound = false;

    // 3.1 Programmatic Check for Clear matches
    for (const [action, patterns] of Object.entries(ACTION_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input.includes(keyword.toLowerCase())) {
          this.analysis.action = {
            status: 'Clear',
            value: action,
            reply: `Detected action is clear: ${action}`
          };
          this.analysis.step3_reply = `Detected action is clear: ${action}`;
          actionFound = true;
          break;
        }
      }
      if (actionFound) break;
    }

    // 3.2 Programmatic Check for Adequate Clarity
    if (!actionFound) {
      for (const [action, phrases] of Object.entries(ACTION_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.action = {
              status: 'Adequate Clarity',
              value: action,
              reply: `Detected action is somewhat clear: ${action}`
            };
            this.analysis.step3_reply = `Detected action is somewhat clear: ${action}`;
            actionFound = true;
            break;
          }
        }
        if (actionFound) break;
      }
    }

    // 3.3 Qdrant Check
    if (!actionFound) {
      const similarity = await calculateLLMSimilarity(input, 'action', Object.keys(ACTION_DICTIONARY));
      if (similarity.score >= SIMILARITY_THRESHOLD) {
        this.analysis.action = {
          status: 'Adequate Clarity',
          value: similarity.match,
          reply: `Detected action is somewhat clear: ${similarity.match}`
        };
        this.analysis.step3_reply = `Detected action is somewhat clear: ${similarity.match}`;
        actionFound = true;
      }
    }

    // 3.4 No action detected
    if (!actionFound) {
      if (this.hasAnyKeywords(input)) {
        this.analysis.action = {
          status: 'Not Clear',
          value: '',
          reply: 'Unable to determine the action.'
        };
        this.analysis.step3_reply = 'Unable to determine the action.';
      } else {
        this.analysis.action = {
          status: 'Not Found',
          value: '',
          reply: 'No action detected.'
        };
        this.analysis.step3_reply = 'No action detected.';
      }
    }
  }

  // Step 4: Filter Check (Conditional + Structured)
  async step4_filterCheck(userInput) {
    const input = userInput.toLowerCase().trim();

    // 4.1 Check Filter Applicability
    if (this.analysis.intent.value === 'menu' &&
        (this.analysis.action.value === 'modify' || this.analysis.action.value === 'search for')) {
      
      // 4.2 Detect Filters Using Regex Patterns
      const detectedFilters = this.detectFilters(userInput);

      if (detectedFilters.length === 0) {
        this.analysis.filters = {
          status: 'Not Found',
          value: [],
          reply: 'No filters detected.'
        };
        this.analysis.step4_reply = 'No filters detected.';
      } else {
        let filterReplies = [];
        let allFiltersValid = true;

        // 4.3-4.6 Analyze each filter
        for (const filter of detectedFilters) {
          const filterAnalysis = await this.analyzeFilter(filter, input);
          filterReplies.push(filterAnalysis.reply);
          if (filterAnalysis.status === 'Not Clear' || filterAnalysis.status === 'Not Found') {
            allFiltersValid = false;
          }
        }

        this.analysis.filters = {
          status: allFiltersValid ? 'Clear' : 'Adequate Clarity',
          value: detectedFilters,
          reply: filterReplies.join(' ')
        };
        this.analysis.step4_reply = filterReplies.join(' ');
      }
    } else {
      this.analysis.filters = {
        status: 'Not Found',
        value: [],
        reply: 'Filters not applicable.'
      };
      this.analysis.step4_reply = 'Filters not applicable.';
    }
  }

  // Step 5: Final Analysis, Response & Logging
  step5_finalAnalysisAndLogging() {
    const mergedReplies = [
      this.analysis.step1_reply,
      this.analysis.step2_reply,
      this.analysis.step3_reply,
      this.analysis.step4_reply
    ].join(' ');

    const intentOk = ['Clear', 'Adequate Clarity'].includes(this.analysis.intent.status);
    const processOk = ['Clear', 'Adequate Clarity'].includes(this.analysis.process.status);
    const actionOk = ['Clear', 'Adequate Clarity'].includes(this.analysis.action.status);
    const filtersOk = ['Clear', 'Adequate Clarity', 'Not Found'].includes(this.analysis.filters.status);

    // 5.3 Generate Final Analysis Reply
    if (intentOk && processOk && actionOk && filtersOk) {
      let filterText = '';
      if (this.analysis.filters.value.length > 0) {
        const filterStrings = this.analysis.filters.value.map(f => `${f.name} ${f.operator} ${f.value}`);
        filterText = ` with ${filterStrings.join(', ')}`;
      }

      this.analysis.finalAnalysis = `Your intent is clear to ${this.analysis.action.value} on ${this.analysis.process.value}${filterText}.`;
      this.analysis.proceed_button = true;
      this.analysis.redirect_flag = false;
      this.analysis.redirect_url = null;
      this.analysis.suggested_action = '';
      this.analysis.example_query = '';
    } else {
      let failureReasons = [];
      if (!intentOk) failureReasons.push('a) Intent');
      if (!processOk) failureReasons.push('b) Process');
      if (!actionOk) failureReasons.push('c) Action');
      if (!filtersOk && this.analysis.intent.value === 'menu' &&
          ['modify', 'search for'].includes(this.analysis.action.value)) {
        failureReasons.push('d) Filter');
      }

      this.analysis.finalAnalysis = `Unable to determine the following: ${failureReasons.join(', ')}. ${mergedReplies}`;
      this.analysis.proceed_button = false;
      this.analysis.redirect_flag = false;
      this.analysis.redirect_url = null;

      // Set suggested action and example query
      if (intentOk) {
        if (this.analysis.intent.value === 'menu') {
          this.analysis.suggested_action = "Try specifying a clear action like 'create' or 'search for' and include filters if needed, e.g., 'due = today'.";
          this.analysis.example_query = "Create an objective where due = today";
        } else if (this.analysis.intent.value === 'help') {
          this.analysis.suggested_action = "Try asking a clear help question, e.g., 'How do I create an objective?'.";
          this.analysis.example_query = "How do I create an objective?";
        }
      }
    }
  }

  detectFilters(userInput) {
    const detectedFilters = [];
    const seen = new Set();

    const isImplicitValueAllowed = (name, value) => {
      const n = String(name).toLowerCase();
      const v = String(value).toLowerCase();
      const inList = (arr) => arr.map(t => t.toLowerCase()).includes(v);

      if (n === 'status') {
        return inList([...FILTER_VALUE_DICTIONARY.status.primary, ...FILTER_VALUE_DICTIONARY.status.synonyms]);
      }
      if (n === 'priority') {
        return inList([...FILTER_VALUE_DICTIONARY.priority.primary, ...FILTER_VALUE_DICTIONARY.priority.synonyms]);
      }
      if (n === 'due' || n === 'deadline' || n === 'due date') {
        return inList([...FILTER_VALUE_DICTIONARY.date.primary, ...FILTER_VALUE_DICTIONARY.date.synonyms]);
      }
      if (n === 'quarter' || n === 'q') {
        return inList([...FILTER_VALUE_DICTIONARY.quarter.primary, ...FILTER_VALUE_DICTIONARY.quarter.synonyms]);
      }
      return false;
    };

    const normalizeOperator = (op) => {
      if (!op) return 'equals';
      const o = op.toString().toLowerCase();
      if (o === '=' || o === 'equals' || o === 'is' || o === 'equal to') return 'equals';
      if (o === '>' || o === 'greater than' || o === 'more than' || o === 'above') return 'greater than';
      if (o === '<' || o === 'less than' || o === 'below' || o === 'under') return 'less than';
      return o;
    };

    const cleanValue = (val) => {
      if (val == null) return '';
      let v = String(val).trim();
      if (v.startsWith('=')) v = v.slice(1).trim();
      v = v.replace(/[.,]$/g, '').trim();
      return v;
    };

    for (const pattern of FILTER_PATTERNS) {
      let match;
      while ((match = pattern.exec(userInput)) !== null) {
        const name = String(match[1] || '').toLowerCase().trim();
        const hasExplicitOperator = typeof match[3] !== 'undefined';
        const rawOperator = hasExplicitOperator ? match[2] : 'equals';
        const rawValue = hasExplicitOperator ? match[3] : match[2];
        const operator = normalizeOperator(rawOperator);
        const value = cleanValue(rawValue);

        if (!name || !value || value.toLowerCase() === name) continue;
        if (!hasExplicitOperator && !isImplicitValueAllowed(name, value)) continue;

        const key = `${name}|${operator}|${value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        detectedFilters.push({
          name,
          operator,
          value,
          originalText: match[0]
        });
      }
    }

    return detectedFilters;
  }

  async analyzeFilter(filter, userInput) {
    const input = userInput.toLowerCase().trim();
    let nameStatus = 'Not Found';
    let operatorStatus = 'Not Found';
    let valueStatus = 'Not Found';
    let nameReply = '';
    let operatorReply = '';
    let valueReply = '';

    // 4.3 Analyze Filter Name
    // Programmatic Check for Filter Name
    for (const [name, patterns] of Object.entries(FILTER_NAME_DICTIONARY)) {
      if ([...patterns.primary, ...patterns.synonyms].map(t => t.toLowerCase()).includes(filter.name.toLowerCase())) {
        nameStatus = 'Clear';
        nameReply = `Filter name detected: ${filter.name}`;
        break;
      }
    }

    if (nameStatus === 'Not Found') {
      for (const [name, phrases] of Object.entries(FILTER_NAME_PHRASE_DICTIONARY)) {
        if (phrases.some(phrase => input.includes(phrase.toLowerCase()))) {
          filter.name = name;
          nameStatus = 'Adequate Clarity';
          nameReply = `Filter name seems somewhat clear: ${name}`;
          break;
        }
      }
    }

    // Qdrant check for name
    if (nameStatus === 'Not Found') {
      const similarity = await calculateLLMSimilarity(filter.name, 'filter name', Object.keys(FILTER_NAME_DICTIONARY));
      if (similarity.score >= SIMILARITY_THRESHOLD) {
        filter.name = similarity.match;
        nameStatus = 'Adequate Clarity';
        nameReply = `Filter name seems somewhat clear: ${similarity.match}`;
      } else {
        nameReply = 'Unable to determine filter name.';
      }
    }

    // 4.4 Analyze Filter Operator
    for (const [operator, patterns] of Object.entries(FILTER_OPERATOR_DICTIONARY)) {
      if ([...patterns.primary, ...patterns.synonyms].map(t => t.toLowerCase()).includes(filter.operator.toLowerCase())) {
        operatorStatus = 'Clear';
        operatorReply = `Operator detected: ${filter.operator}`;
        break;
      }
    }

    if (operatorStatus === 'Not Found') {
      for (const [operator, phrases] of Object.entries(FILTER_OPERATOR_PHRASE_DICTIONARY)) {
        if (phrases.some(phrase => input.includes(phrase.toLowerCase()))) {
          filter.operator = operator;
          operatorStatus = 'Adequate Clarity';
          operatorReply = `Operator seems somewhat clear: ${operator}`;
          break;
        }
      }
    }

    // Qdrant check for operator
    if (operatorStatus === 'Not Found') {
      const similarity = await calculateLLMSimilarity(filter.operator, 'filter operator', Object.keys(FILTER_OPERATOR_DICTIONARY));
      if (similarity.score >= SIMILARITY_THRESHOLD) {
        filter.operator = similarity.match;
        operatorStatus = 'Adequate Clarity';
        operatorReply = `Operator seems somewhat clear: ${similarity.match}`;
      } else {
        operatorReply = 'Unable to determine operator.';
      }
    }

    // 4.5 Analyze Filter Value
    for (const [category, patterns] of Object.entries(FILTER_VALUE_DICTIONARY)) {
      if ([...patterns.primary, ...patterns.synonyms].map(t => t.toLowerCase()).includes(filter.value.toLowerCase())) {
        valueStatus = 'Clear';
        valueReply = `Value detected: ${filter.value}`;
        break;
      }
    }

    if (valueStatus === 'Not Found') {
      for (const [category, phrases] of Object.entries(FILTER_VALUE_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            filter.value = phrase;
            valueStatus = 'Adequate Clarity';
            valueReply = `Value seems somewhat clear: ${phrase}`;
            break;
          }
        }
        if (valueStatus !== 'Not Found') break;
      }
    }

    // Qdrant check for value
    if (valueStatus === 'Not Found') {
      const similarity = await calculateLLMSimilarity(filter.value, 'filter value', Object.values(FILTER_VALUE_DICTIONARY).flatMap(v => [...v.primary, ...v.synonyms]));
      if (similarity.score >= SIMILARITY_THRESHOLD) {
        filter.value = similarity.match;
        valueStatus = 'Adequate Clarity';
        valueReply = `Value seems somewhat clear: ${similarity.match}`;
      } else {
        valueReply = 'Unable to determine value.';
      }
    }

    // 4.6 Finalize Filter Status
    const overallStatus = (nameStatus === 'Clear' && operatorStatus === 'Clear' && valueStatus === 'Clear') ? 'Clear' :
      (nameStatus !== 'Not Found' || operatorStatus !== 'Not Found' || valueStatus !== 'Not Found') ? 'Adequate Clarity' : 'Not Found';

    return {
      status: overallStatus,
      reply: `${nameReply} ${operatorReply} ${valueReply}`.trim()
    };
  }

  hasAnyKeywords(input) {
    const allKeywords = [
      ...Object.values(INTENT_DICTIONARY).flatMap(v => [...v.primary, ...v.synonyms]),
      ...Object.values(PROCESS_DICTIONARY).flatMap(v => [...v.primary, ...v.synonyms]),
      ...Object.values(ACTION_DICTIONARY).flatMap(v => [...v.primary, ...v.synonyms]),
      ...Object.values(FILTER_NAME_DICTIONARY).flatMap(v => [...v.primary, ...v.synonyms]),
      ...Object.values(FILTER_OPERATOR_DICTIONARY).flatMap(v => [...v.primary, ...v.synonyms]),
      ...Object.values(FILTER_VALUE_DICTIONARY).flatMap(v => [...v.primary, ...v.synonyms]),
      ...Object.values(INTENT_PHRASE_DICTIONARY).flat(),
      ...Object.values(PROCESS_PHRASE_DICTIONARY).flat(),
      ...Object.values(ACTION_PHRASE_DICTIONARY).flat(),
      ...Object.values(FILTER_NAME_PHRASE_DICTIONARY).flat(),
      ...Object.values(FILTER_OPERATOR_PHRASE_DICTIONARY).flat(),
      ...Object.values(FILTER_VALUE_PHRASE_DICTIONARY).flat()
    ].map(k => k.toLowerCase());

    return allKeywords.some(keyword => input.toLowerCase().includes(keyword));
  }

  async performAnalysis(userInput) {
    this.reset();
    this.analysis.userInput = userInput;

    // Step 1: Intent Conclusion
    await this.step1_intentConclusion(userInput);

    // Step 2: Process Conclusion
    await this.step2_processConclusion(userInput);

    // Step 2.5: Help Intent Redirect Check (NEW)
    const shouldRedirect = this.step2_5_helpIntentRedirectCheck();
    
    if (shouldRedirect) {
      // Skip Step 3 and Step 4, go directly to logging and return
      return this.analysis;
    }

    // Step 3: Action Conclusion (only if not redirecting)
    await this.step3_actionConclusion(userInput);

    // Step 4: Filter Check (only if not redirecting)
    await this.step4_filterCheck(userInput);

    // Step 5: Final Analysis and Logging
    this.step5_finalAnalysisAndLogging();

    return this.analysis;
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/analyze', async (req, res) => {
  const { sentence } = req.body;

  if (!sentence || sentence.trim().length === 0) {
    return res.status(400).json({
      error: 'Please provide a sentence to analyze',
      analysis_reply: 'No input provided.',
      proceed_button: false,
      redirect_flag: false,
      redirect_url: null,
      suggested_action: '',
      example_query: ''
    });
  }

  try {
    const analyzer = new ConversationAnalyzer();
    const analysis = await analyzer.performAnalysis(sentence.trim());

    // Format filters for logging
    const filtersText = analysis.filters.value.length > 0 ?
      analysis.filters.value.map(f => `${f.name}=${f.value}`).join(',') :
      analysis.filters.status;

    // 5.4 Logging - Table format
    logs.push({
      Sentence_ID: logs.length + 1,
      Intent: analysis.intent.status,
      Process: analysis.process.status,
      Action: analysis.action.status,
      Filters: filtersText,
      Final_Analysis_Response_Status: analysis.finalAnalysis,
      Suggested_Action: analysis.suggested_action,
      Example_Query: analysis.example_query,
      Proceed_Button_Status: analysis.proceed_button ? 'Yes' : 'No',
      Redirect_Flag: analysis.redirect_flag ? 'Yes' : 'No',
      Redirect_URL: analysis.redirect_url || null,
      User_Input: analysis.userInput,
      Timestamp: new Date().toISOString()
    });

    res.json({
      analysis_reply: analysis.finalAnalysis,
      proceed_button: analysis.proceed_button,
      redirect_flag: analysis.redirect_flag,
      redirect_url: analysis.redirect_url,
      suggested_action: analysis.suggested_action,
      example_query: analysis.example_query
    });

  } catch (error) {
    console.error('Analysis error:', error.message, error.stack);
    res.status(500).json({
      error: `Internal server error during analysis: ${error.message}`,
      analysis_reply: 'An error occurred while analyzing your request. Please try again.',
      proceed_button: false,
      redirect_flag: false,
      redirect_url: null,
      suggested_action: 'Try a simpler sentence or ensure the server is running correctly.',
      example_query: 'I want to create an objective'
    });
  }
});

app.get('/logs', (req, res) => {
  res.json(logs.slice(-50));
});

app.get('/health', async (req, res) => {
  try {
    const collections = await qdrantService.client.getCollections();
    const collectionInfo = await qdrantService.getCollectionInfo();

    res.json({
      status: 'healthy',
      qdrant: 'connected',
      collections: collections.collections.length,
      indexedPoints: collectionInfo ? collectionInfo.points_count : 0
    });
  } catch (error) {
    console.error('Health check error:', error.message);
    res.status(500).json({
      status: 'error',
      qdrant: 'disconnected',
      message: error.message
    });
  }
});

async function initializeServer() {
  try {
    console.log('Initializing server...');
    await qdrantService.initialize();

    const collectionInfo = await qdrantService.getCollectionInfo();
    if (!collectionInfo || collectionInfo.points_count === 0) {
      console.log('Collection is empty. Indexing dictionaries...');
      await qdrantService.indexDictionaries({
        intent: INTENT_DICTIONARY,
        intentPhrases: INTENT_PHRASE_DICTIONARY,
        action: ACTION_DICTIONARY,
        actionPhrases: ACTION_PHRASE_DICTIONARY,
        process: PROCESS_DICTIONARY,
        processPhrases: PROCESS_PHRASE_DICTIONARY,
        filterName: FILTER_NAME_DICTIONARY,
        filterNamePhrases: FILTER_NAME_PHRASE_DICTIONARY,
        filterOperator: FILTER_OPERATOR_DICTIONARY,
        filterOperatorPhrases: FILTER_OPERATOR_PHRASE_DICTIONARY,
        filterValue: FILTER_VALUE_DICTIONARY,
        filterValuePhrases: FILTER_VALUE_PHRASE_DICTIONARY
      });
    } else {
      console.log(`Collection already has ${collectionInfo.points_count} indexed points. Skipping indexing.`);
    }

    console.log('Server initialization complete');
  } catch (error) {
    console.error('Failed to initialize server:', error);
    process.exit(1);
  }
}

initializeServer().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to view the application`);
    console.log(`Qdrant URL: ${process.env.QDRANT_URL || 'http://localhost:6333'}`);
  });
});

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  process.exit(0);
});
