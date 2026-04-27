import browser from 'webextension-polyfill';
import {deepHtmlSearch, deepHtmlFindByTextContent} from "./domHelper";

let isSuspendRunning = false;
const components = [];
let questions = [];
const componentUrls = [];

const processedQuestionElements = new WeakSet();
const processedLabels = new WeakSet();
const processedMatchPairs = new WeakSet();
const processedDropdownOptions = new WeakSet();
const processedOpenTextQuestions = new WeakSet();
const processedFillBlankDivs = new WeakSet();
const processedTableRows = new WeakSet();
const processedOpenTextButtons = new WeakSet();
const processedTableOptions = new WeakSet();
const processedFillBlankOptions = new WeakSet();
const processedTabsContainers = new WeakSet();
const processedTabButtons = new WeakSet();
const processedAccordionContainers = new WeakSet();
const processedVideoElements = new WeakSet();
const pendingVideoElements = new WeakSet();
const processedInteractionDocuments = new WeakSet();
const processedMatchingContainers = new WeakSet();

const TABS_SELECTORS = '.tabs__nav-item-btn, .js-tabs-nav-item-btn-click, .tabs__nav button, .tabs__nav-inner button, [role="tab"], [aria-controls*="tabpanel"]';
const TABS_CONTAINER_SELECTORS = '.tabs__nav, .component.tabs, .tab__widget, .tabs__widget, tabs-view';
const ACCORDION_SELECTORS = '.accordion__item-btn, [aria-controls^="accordion-item"]';
const ACCORDION_CONTAINER_SELECTORS = '.accordion__widget, .component.accordion, accordion-view';
const VIDEO_SELECTORS = 'video, .vjs-tech, iframe[src*="brightcovePlayer"], .vjs-big-play-button, .vjs-play-control';
const VIDEO_CONTAINER_SELECTORS = '.component__widget, .video__widget, .component, block-view, article-view';
const PAGE_TRACER_SELECTORS = '.pageTracer-button, [data-page-tracer-button-id], pagetracer-view button.btn__action';
const PAGE_TRACER_CLOSE_SELECTORS = 'pagetracer-popup #close-btn, pagetracer-popup .close-button, #close-btn, .close-button';
const NOTIFY_CLOSE_SELECTORS = '.js-notify-close-btn, .notify__close-btn';

// Submit selectors — ordered most-specific first
const QUIZ_SUBMIT_SELECTORS = [
  'assessment-toolbar-view button.submit-button',
  'assessment-toolbar-view button[aria-label="submit"]',
  'button.submit-button.abs__btn-arrow',
  'button.submit-button',
  'buttons-view button.btn-text.btn__action.js-btn-action',
  'button.btn-text.btn__action.js-btn-action[aria-label="Enviar"]',
  'button.adaptive-assessment-submit[aria-label="Enviar"]',
  '.adaptive-assessment-submit',
  'button[aria-label="Enviar"]',
  'button[aria-label="submit"]',
].join(', ');

// Selectors only for the document-level toolbar (used as fallback)
const TOOLBAR_SUBMIT_SELECTORS = [
  'assessment-toolbar-view button.submit-button',
  'assessment-toolbar-view button[aria-label="submit"]',
  'button.submit-button.abs__btn-arrow',
  'button.submit-button',
].join(', ');

const MATCHING_CONTAINER_SELECTORS = 'matching-view, object-matching-view, .matching__widget';
const MATCHING_DROPDOWN_SELECTORS = 'matching-dropdown-view, .matching__item_main';

const FINAL_CONFIRM_SELECTOR = '#confirm-exam';
const AUTOMATION_CLICK_DELAY = 140;
const AUTOMATION_RETRY_DELAY = 100;
const AUTOMATION_RETRY_LIMIT = 15;
// 4 burst clicks, staggered: instant → 60ms → 150ms → 300ms
const SUBMIT_BURST_DELAYS = [0, 60, 150, 300];

let globalInteractionAutomationsInitialized = false;

// ─── Core helpers ─────────────────────────────────────────────────────────────
const clickElement = element => {
  if (!element) return false;
  try { element.scrollIntoView({block: 'center', inline: 'center'}); } catch (e) {}
  element.click();
  return true;
};

const isElementClickable = element => {
  if (!element) return false;
  if (element.disabled) return false;
  if (element.getAttribute?.('aria-disabled') === 'true') return false;
  if (element.classList?.contains('disabled') || element.classList?.contains('is-disabled')) return false;
  return true;
};

const isElementVisible = element => {
  if (!element) return false;
  try {
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
  } catch (e) { return true; }
  return true;
};

const clickCheckbox = checkbox => {
  if (!checkbox) return false;
  if (!checkbox.checked) {
    checkbox.click();
    checkbox.dispatchEvent(new Event('input', {bubbles: true}));
    checkbox.dispatchEvent(new Event('change', {bubbles: true}));
  }
  return checkbox.checked;
};

const findPathElement = (event, selector) => (event.composedPath?.() || [])
  .find(node => node?.matches?.(selector)) || null;

const findClosestPathElement = (event, selector) => (event.composedPath?.() || [])
  .find(node => node?.closest?.(selector))?.closest?.(selector) || null;

const getOrderedElements = (container, selector) => [...container.querySelectorAll(selector)]
  .sort((a, b) => Number(a.dataset.index || 0) - Number(b.dataset.index || 0));

const scheduleClicks = (elements, delay = AUTOMATION_CLICK_DELAY) => {
  elements.forEach((element, index) => {
    setTimeout(() => clickElement(element), index * delay);
  });
};

// ─── Submit burst — scoped to questionDiv ────────────────────────────────────
// Searches for the submit button ONLY within `scope` (the questionDiv that was
// clicked). This prevents scrolling the page to a different question's button.
// Falls back to the document-level toolbar button (assessment-toolbar-view)
// which lives outside any question container.
//
// Fires exactly SUBMIT_BURST_DELAYS.length times (4), stopping early if:
//   - the notify/result popup appears (submission accepted)
//   - the button disappears or becomes disabled
//
// scheduleNotifyClose() is called as soon as the popup is detected.

const burstSubmitFrom = (scope) => {
  let cancelled = false;

  const isNotifyVisible = () => !!deepHtmlSearch(document, NOTIFY_CLOSE_SELECTORS);

  const findBtn = () => {
    // 1. Try within the question's own container
    if (scope) {
      const local = deepHtmlSearch(scope, QUIZ_SUBMIT_SELECTORS);
      if (local) return local;
    }
    // 2. Fallback: toolbar at document level (outside any article)
    return deepHtmlSearch(document, TOOLBAR_SUBMIT_SELECTORS);
  };

  SUBMIT_BURST_DELAYS.forEach(delay => {
    setTimeout(() => {
      if (cancelled) return;

      // Popup appeared → submission accepted → stop and close
      if (isNotifyVisible()) {
        cancelled = true;
        scheduleNotifyClose();
        return;
      }

      const btn = findBtn();

      // Button gone → accepted
      if (!btn || !isElementVisible(btn)) {
        cancelled = true;
        return;
      }

      // Button disabled → not ready yet, skip this tick (later ticks will retry)
      if (!isElementClickable(btn)) return;

      try { btn.scrollIntoView({block: 'center', inline: 'center'}); } catch (e) {}
      btn.click();
    }, delay);
  });
};

const scheduleQuizSubmitFrom = (questionDiv) => burstSubmitFrom(questionDiv || null);

// ─── Popup close helpers ──────────────────────────────────────────────────────
const scheduleButtonClickBySelector = (selector, opts = {}) => {
  const retries = opts.retries ?? AUTOMATION_RETRY_LIMIT;
  const delay = opts.delay ?? AUTOMATION_RETRY_DELAY;
  let attempts = 0;

  const tryClick = () => {
    attempts++;
    const button = deepHtmlSearch(document, selector);
    if (button && isElementClickable(button) && isElementVisible(button)) {
      button.click();
      button.click();
      button.click();
      return;
    }
    if (attempts < retries) setTimeout(tryClick, delay);
  };

  tryClick();
};

const scheduleFinalScreenAutomation = () => {
  let attempts = 0;
  const tick = () => {
    attempts++;
    const confirmCheckbox = deepHtmlSearch(document, FINAL_CONFIRM_SELECTOR);
    if (confirmCheckbox) clickCheckbox(confirmCheckbox);
    const submitButton =
      deepHtmlSearch(document, '.adaptive-assessment-submit') ||
      deepHtmlSearch(document, QUIZ_SUBMIT_SELECTORS);
    if (submitButton && isElementClickable(submitButton)) {
      clickElement(submitButton);
      return;
    }
    if (attempts < AUTOMATION_RETRY_LIMIT) setTimeout(tick, AUTOMATION_RETRY_DELAY);
  };
  tick();
};

const schedulePageTracerClose = () => scheduleButtonClickBySelector(PAGE_TRACER_CLOSE_SELECTORS, {retries: AUTOMATION_RETRY_LIMIT, delay: 80});
const scheduleNotifyClose = () => scheduleButtonClickBySelector(NOTIFY_CLOSE_SELECTORS, {retries: AUTOMATION_RETRY_LIMIT, delay: 80});

// ─── Video helpers ────────────────────────────────────────────────────────────
const finalizeVideoElement = video => {
  if (!video || processedVideoElements.has(video) || pendingVideoElements.has(video))
    return false;

  const complete = () => {
    if (processedVideoElements.has(video)) return;
    try {
      if (Number.isFinite(video.duration) && video.duration > 0)
        video.currentTime = Math.max(video.duration - 0.01, 0);
    } catch (e) {}
    try { video.pause(); } catch (e) {}
    ['timeupdate', 'seeking', 'seeked', 'ended', 'pause'].forEach(type => {
      try { video.dispatchEvent(new Event(type, {bubbles: true})); } catch (e) {}
    });
    pendingVideoElements.delete(video);
    processedVideoElements.add(video);
  };

  if (Number.isFinite(video.duration) && video.duration > 0) {
    complete();
  } else {
    pendingVideoElements.add(video);
    ['loadedmetadata', 'loadeddata', 'durationchange', 'canplay'].forEach(type => {
      video.addEventListener(type, complete, {once: true});
    });
    setTimeout(complete, 50);
    setTimeout(complete, 400);
  }
  return true;
};

const finalizeVideosDeep = root => {
  try { [...(root.querySelectorAll?.('video') || [])].forEach(finalizeVideoElement); } catch (e) {}
  try {
    [...(root.querySelectorAll?.('*') || [])]
      .filter(el => el.shadowRoot)
      .forEach(el => finalizeVideosDeep(el.shadowRoot));
  } catch (e) {}
};

const finalizeVideosNear = trigger => {
  const scope = trigger?.closest?.(VIDEO_CONTAINER_SELECTORS) || trigger || document;
  finalizeVideosDeep(scope);
  finalizeVideosDeep(document);
};

// ─── Tabs / Accordion ─────────────────────────────────────────────────────────
const automateTabsFrom = trigger => {
  const container = trigger?.closest?.(TABS_CONTAINER_SELECTORS);
  if (!container || processedTabsContainers.has(container)) return;
  processedTabsContainers.add(container);
  const buttonsToClick = getOrderedElements(container, TABS_SELECTORS)
    .filter(button => !processedTabButtons.has(button))
    .filter(button => button.getAttribute('aria-selected') !== 'true')
    .filter(button => !button.classList?.contains('is-visited'));
  buttonsToClick.forEach(button => processedTabButtons.add(button));
  scheduleClicks(buttonsToClick);
};

const automateAccordionFrom = trigger => {
  const container = trigger?.closest?.(ACCORDION_CONTAINER_SELECTORS);
  if (!container || processedAccordionContainers.has(container)) return;
  processedAccordionContainers.add(container);
  scheduleClicks(getOrderedElements(container, ACCORDION_SELECTORS).filter(button => button.getAttribute('aria-expanded') !== 'true'));
};

// ─── Matching dropdowns ───────────────────────────────────────────────────────
const automateMatchingFrom = trigger => {
  const container = trigger?.closest?.(MATCHING_CONTAINER_SELECTORS);
  if (!container || processedMatchingContainers.has(container)) return;
  processedMatchingContainers.add(container);

  const allDropdowns = [...container.querySelectorAll(MATCHING_DROPDOWN_SELECTORS)];

  allDropdowns.forEach((dropdown, i) => {
    setTimeout(() => {
      dropdown.click();
      setTimeout(() => {
        const option = deepHtmlSearch(dropdown, '[role="option"]:not([aria-disabled="true"]), .dropdown__item:not(.is-disabled)', true);
        if (option) option.click();
      }, 60);
    }, i * 90);
  });

  // Submit scoped to this matching container
  setTimeout(() => scheduleQuizSubmitFrom(container), allDropdowns.length * 90 + 120);
};

// ─── Global click listener ────────────────────────────────────────────────────
const initGlobalInteractionAutomations = () => {
  const attach = rootDocument => {
    if (!rootDocument || processedInteractionDocuments.has(rootDocument)) return;
    processedInteractionDocuments.add(rootDocument);

    rootDocument.addEventListener('click', event => {
      if (!event.isTrusted) return;

      const videoTrigger = findPathElement(event, VIDEO_SELECTORS) || findClosestPathElement(event, VIDEO_CONTAINER_SELECTORS);
      if (videoTrigger) finalizeVideosNear(videoTrigger);

      const tabsTrigger = findPathElement(event, TABS_SELECTORS);
      if (tabsTrigger) automateTabsFrom(tabsTrigger);

      const accordionTrigger = findPathElement(event, ACCORDION_SELECTORS);
      if (accordionTrigger) automateAccordionFrom(accordionTrigger);

      const matchingTrigger = findPathElement(event, MATCHING_DROPDOWN_SELECTORS) ||
        findClosestPathElement(event, MATCHING_CONTAINER_SELECTORS);
      if (matchingTrigger) automateMatchingFrom(matchingTrigger);

      const pageTracerTrigger = findPathElement(event, PAGE_TRACER_SELECTORS);
      if (pageTracerTrigger) {
        schedulePageTracerClose();
        scheduleNotifyClose();
      }

      if (findPathElement(event, FINAL_CONFIRM_SELECTOR) || findClosestPathElement(event, 'finalscreen-view, .finalscreen, .adaptive-assessment-submit')) {
        scheduleFinalScreenAutomation();
      }

      scheduleNotifyClose();
    }, true);
  };

  if (!globalInteractionAutomationsInitialized) {
    globalInteractionAutomationsInitialized = true;
    attach(document);
  }
};

browser.runtime.onMessage.addListener(async (request) => {
  if (request?.componentsUrl && typeof request.componentsUrl === 'string' && !componentUrls.includes(request.componentsUrl)) {
    componentUrls.push(request.componentsUrl);
    await setComponents(request.componentsUrl);
    suspendMain();
  }
});

const setComponents = async url => {
  const getTextContentOfText = htmlString => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');
    return doc.body.textContent;
  };
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    let json = await res.json();
    json = json
      .filter(component => component._items)
      .filter(component => !components.map(c => c._id).includes(component._id))
      .map(component => {
        component.body = getTextContentOfText(component.body);
        return component;
      });
    components.push(...json);
  } catch (e) {
    console.error(e);
  }
};

const setQuestionSections = async () => {
  let isAtLeaseOneSet = false;

  for (const component of components) {
    const questionDiv = deepHtmlSearch(document, `.${CSS.escape(component._id)}`);

    if (questionDiv) {
      isAtLeaseOneSet = true;
      let questionType = 'basic';

      if (component._items[0].text && component._items[0]._options) {
        questionType = 'dropdownSelect';
      } else if (component._items[0].question && component._items[0].answer) {
        questionType = 'match';
      } else if (isGraphicQuestion(component._items)) {
        questionType = 'unsupportedGraphic';
      } else if (component._items[0].id && component._items[0]._options?.text) {
        questionType = 'openTextInput';
      } else if (component._items[0].preText && component._items[0].postText && component._items[0]._options?.[0]?.text) {
        questionType = 'fillBlanks';
      } else if (component._items[0]._options?.[0].text && typeof component._items[0]._options?.[0]._isCorrect === 'boolean') {
        questionType = 'tableDropdown';
      }

      questions.push({
        questionDiv,
        id: component._id,
        answersLength: component._items.length,
        questionType,
        items: component._items
      });
    }
  }

  if (!isAtLeaseOneSet) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return await setQuestionSections();
  }
};

const findQuestionElement = document => {
  for (const component of components) {
    const questionElement = deepHtmlFindByTextContent(document, component.body);
    if (questionElement) return questionElement;
  }
};

const findAnswerInputsBasic = (document, questionId, answersLength, inputs = []) => {
  for (let i = 0; i < answersLength; i++) {
    const input = deepHtmlSearch(document, `#${CSS.escape(questionId)}-${i}-input`);
    const label = deepHtmlSearch(document, `#${CSS.escape(questionId)}-${i}-label`);
    if (input) {
      inputs.push({input, label});
      if (inputs.length === answersLength) return inputs;
    }
  }
};

const findAnswerInputsMatch = (document, answersLength, buttons = []) => {
  for (let i = 0; i < answersLength; i++) {
    const answerInputs = deepHtmlSearch(document, `[data-id="${i}"]`, false, 2);
    if (answerInputs) {
      buttons.push(answerInputs);
      if (buttons.length === answersLength) return buttons;
    }
  }
};

const isGraphicQuestion = items => Boolean(items?.[0]?._graphic?.src);

const setQuestionElements = () => {
  questions.map(question => {
    if (question.questionType === 'basic') {
      question.questionElement = findQuestionElement(question.questionDiv);
      question.inputs = findAnswerInputsBasic(question.questionDiv, question.id, question.answersLength) || [];
    } else if (question.questionType === 'match') {
      question.questionElement = findQuestionElement(question.questionDiv);
      question.inputs = findAnswerInputsMatch(question.questionDiv, question.answersLength) || [];
    } else if (question.questionType === 'dropdownSelect') {
      setDropdownSelectQuestions(question);
      question.skip = true;
    } else if (question.questionType === 'unsupportedGraphic') {
      question.skip = true;
    } else if (question.questionType === 'openTextInput') {
      setOpenTextInputQuestions(question);
      question.skip = true;
    } else if (question.questionType === 'fillBlanks') {
      setFillBlanksQuestions(question);
      question.skip = true;
    } else if (question.questionType === 'tableDropdown') {
      setTableDropdownQuestions(question);
      question.skip = true;
    }
    return question;
  });
};

const setDropdownSelectQuestions = question => {
  question.items.forEach((item, i) => {
    const questionDiv = deepHtmlSearch(question.questionDiv, `[index="${i}"]`, true);
    const questionElement = deepHtmlFindByTextContent(questionDiv, item.text.trim());

    for (const [index, option] of item._options.entries()) {
      if (option._isCorrect) {
        const optionElement = deepHtmlSearch(questionDiv, `#dropdown__item-index-${index}`, true);
        questions.push({
          questionDiv,
          questionElement,
          inputs: [optionElement],
          questionType: question.questionType
        });
        return;
      }
    }
  });
};

const setOpenTextInputQuestions = question => {
  question.items.forEach((item, i) => {
    const questionElement = deepHtmlSearch(question.questionDiv, '#' + CSS.escape(`${question.id}-option-${i}`));
    const button = deepHtmlSearch(question.questionDiv, `.current-item-${i}`, true);

    if (questionElement && !processedOpenTextQuestions.has(questionElement)) {
      processedOpenTextQuestions.add(questionElement);

      questionElement.addEventListener('click', () => {
        setTimeout(() => {
          button.click();
          const currentQuestion = questionElement.textContent?.trim();
          const position = question.items.find(item => item._options.text.trim() === currentQuestion)?.position?.[0];
          if (position) {
            setTimeout(() => {
              const input = deepHtmlSearch(question.questionDiv, `[data-target="${position}"]`);
              if (input) {
                input?.click();
              } else {
                question.questionDiv.click();
              }
            }, 100);
          }
        }, 100);
      });
    }

    if (button && !processedOpenTextButtons.has(button)) {
      processedOpenTextButtons.add(button);

      button.addEventListener('click', () => {
        setTimeout(() => {
          const currentQuestion = questionElement?.textContent?.trim();
          const position = question.items.find(item => item._options.text.trim() === currentQuestion)?.position?.[0];
          if (position) {
            setTimeout(() => {
              const input = deepHtmlSearch(question.questionDiv, `[data-target="${position}"]`);
              if (input && !input.dataset.hoverListenerAdded) {
                input.dataset.hoverListenerAdded = 'true';
                input.addEventListener('mouseover', e => {
                  if (e.ctrlKey) input.click();
                });
              }
            }, 100);
          }
        }, 100);
      });
    }
  });
};

const setFillBlanksQuestions = question => {
  const questionDivs = [...deepHtmlSearch(question.questionDiv, '.fillblanks__item', true, question.answersLength)];

  questionDivs.forEach(questionDiv => {
    if (processedFillBlankDivs.has(questionDiv)) return;
    processedFillBlankDivs.add(questionDiv);

    const textContent = questionDiv.textContent.trim();

    for (const item of question.items) {
      if (textContent.startsWith(removeTagsFromString(item.preText)) && textContent.endsWith(removeTagsFromString(item.postText))) {
        for (const option of item._options) {
          if (option._isCorrect) {
            const dropdownItems = [...deepHtmlSearch(questionDiv, '.dropdown__item', true, item._options.length)];
            for (const dropdownItem of dropdownItems) {
              if (processedFillBlankOptions.has(dropdownItem)) break;
              processedFillBlankOptions.add(dropdownItem);
              if (dropdownItem.textContent.trim() === option.text.trim()) {
                questionDiv.addEventListener('click', (e) => {
                  if (!e.target.textContent?.trim()) return;
                  dropdownItem.click();
                });
                dropdownItem.addEventListener('mouseover', e => {
                  if (e.ctrlKey) dropdownItem.click();
                });
                break;
              }
            }
            break;
          }
        }
        break;
      }
    }
  });
};

const setTableDropdownQuestions = question => {
  const sectionDivs = Array.from(deepHtmlSearch(question.questionDiv, 'tbody tr', true, question.answersLength));

  sectionDivs.forEach((section, i) => {
    if (processedTableRows.has(section)) return;
    processedTableRows.add(section);

    const optionElements = Array.from(deepHtmlSearch(section, '[role="option"]', true, question.items[i]._options.length));
    const correctOption = question.items[i]._options.find(option => option._isCorrect);

    for (const optionElement of optionElements) {
      if (processedTableOptions.has(optionElement)) break;
      processedTableOptions.add(optionElement);
      if (optionElement.textContent.trim() === correctOption.text.trim()) {
        section.addEventListener('click', () => { optionElement.click(); });
        optionElement.addEventListener('mouseover', e => {
          if (e.ctrlKey) optionElement.click();
        });
        break;
      }
    }
  });
};

// ─── Click & Hover listeners ──────────────────────────────────────────────────
const initClickListeners = () => {
  questions.forEach((question) => {
    if (question.skip || !question.questionElement) return;
    if (processedQuestionElements.has(question.questionElement)) return;
    processedQuestionElements.add(question.questionElement);

    question.questionElement.addEventListener('click', () => {
      if (question.questionType === 'basic') {
        const component = components.find(c => c._id === question.id);
        let shouldSubmitAfterMark = false;

        question.inputs.forEach(({input, label}, i) => {
          if (input.checked) label.click();
          if (component._items[i]._shouldBeSelected) {
            setTimeout(() => label.click(), 10);
            shouldSubmitAfterMark = true;
          }
        });

        if (shouldSubmitAfterMark) {
          // Scoped to this question's container — won't scroll elsewhere
          scheduleQuizSubmitFrom(question.questionDiv);
        }
      } else if (question.questionType === 'match') {
        question.inputs.forEach(input => {
          input[0].click();
          input[1].click();
        });
        scheduleQuizSubmitFrom(question.questionDiv);
      } else if (question.questionType === 'dropdownSelect') {
        question.inputs[0]?.click();
        scheduleQuizSubmitFrom(question.questionDiv);
      }
    });
  });
};

const initHoverListeners = () => {
  questions.forEach((question) => {
    if (question.skip) return;
    const component = components.find(c => c._id === question.id);

    if (question.questionType === 'basic') {
      question.inputs.forEach(({input, label}, i) => {
        if (!label || processedLabels.has(label)) return;
        processedLabels.add(label);

        label.addEventListener('mouseover', e => {
          if (e.ctrlKey) {
            let shouldSubmitAfterMark = false;
            if (input.checked) label.click();
            if (component._items[i]._shouldBeSelected) {
              setTimeout(() => label.click(), 10);
              shouldSubmitAfterMark = true;
            }
            if (shouldSubmitAfterMark) {
              scheduleQuizSubmitFrom(question.questionDiv);
            }
          }
        });
      });
    } else if (question.questionType === 'match') {
      question.inputs.forEach(input => {
        if (!input[0] || processedMatchPairs.has(input[0])) return;
        processedMatchPairs.add(input[0]);
        input[0].addEventListener('mouseover', e => {
          if (e.ctrlKey) {
            input[0].click();
            input[1].click();
          }
        });
      });
    } else if (question.questionType === 'dropdownSelect') {
      const optionEl = question.inputs[0];
      if (!optionEl || processedDropdownOptions.has(optionEl)) return;
      processedDropdownOptions.add(optionEl);
      optionEl.addEventListener('mouseover', e => {
        if (e.ctrlKey) optionEl.click();
      });
    }
  });
};

const removeTagsFromString = string => string.replace(/<[^>]*>?/gm, '').trim();

const setIsReady = () => {
  for (const component of components) {
    const questionDiv = deepHtmlSearch(document, `.${CSS.escape(component._id)}`);
    if (questionDiv) return true;
  }
  return false;
};

const main = async () => {
  initGlobalInteractionAutomations();
  questions = [];
  await setQuestionSections();
  setQuestionElements();
  initClickListeners();
  initHoverListeners();
};

const suspendMain = () => {
  if (isSuspendRunning) return;
  isSuspendRunning = true;
  const checking = async () => {
    if (setIsReady()) {
      clearInterval(interval);
      main().finally(() => { isSuspendRunning = false; });
    }
  };
  const interval = setInterval(checking, 1000);
};

if (window) {
  initGlobalInteractionAutomations();
  setInterval(() => {
    initGlobalInteractionAutomations();
    if (isSuspendRunning || components.length === 0) return;

    let visibleContainers = 0;
    for (const component of components) {
      if (deepHtmlSearch(document, `.${CSS.escape(component._id)}`)) visibleContainers++;
    }
    if (visibleContainers !== questions.length) suspendMain();
  }, 1000);
}
