/* lab34/health report renderer.
 *
 * Everything on the page is built from the YAML document embedded in this
 * file. Nothing is hard-coded here except layout: colours come from the
 * document's `theme`, section titles and ordering from its `navigation`, and
 * every value from the section it belongs to. Edit the YAML, reload, and the
 * report changes.
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // --- tiny DOM helpers ----------------------------------------------------

  function el(tag, props, children) {
    var node = document.createElement(tag);
    applyProps(node, props);
    append(node, children);
    return node;
  }

  function svg(tag, props, children) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var key in props || {}) {
      if (props[key] !== undefined && props[key] !== null) node.setAttribute(key, String(props[key]));
    }
    append(node, children);
    return node;
  }

  function applyProps(node, props) {
    for (var key in props || {}) {
      var value = props[key];
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') { for (var s in value) node.style.setProperty(s, value[s]); }
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, String(value));
    }
  }

  function append(node, children) {
    if (children === undefined || children === null) return;
    var list = Array.isArray(children) ? children : [children];
    for (var i = 0; i < list.length; i += 1) {
      var child = list[i];
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
    }
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // --- document ------------------------------------------------------------

  function readDocument() {
    var holder = document.getElementById('report-data');
    if (!holder) throw new Error('report data is missing');
    // The one transform applied when embedding: a literal "</script" inside a
    // value would otherwise close this block early.
    var text = holder.textContent.replace(/<\\\/(script)/gi, '</$1');
    return window.jsyaml.load(text);
  }

  var doc = readDocument();
  var theme = doc.theme || {};

  function indicatorColor(name) {
    return (theme.indicator || {})[name] || (theme.palette || {}).text_muted || '#9B9797';
  }

  function directionColor(name) {
    return (theme.direction || {})[name] || (theme.palette || {}).text_faint || '#C9C6C2';
  }

  function ageColor(section, slug) {
    var found = (section.age_indicators || []).filter(function (i) { return i.slug === slug; })[0];
    return found ? found.color : (theme.palette || {}).text_strong;
  }

  function applyTheme() {
    var root = document.documentElement;
    var palette = theme.palette || {};
    for (var token in palette) root.style.setProperty('--' + token.replace(/_/g, '-'), palette[token]);
  }

  // --- charts --------------------------------------------------------------

  /** Sparkline points across a 100x26 box, skipping runs with no value. */
  function sparkPoints(series) {
    var points = [];
    var values = series.filter(function (v) { return typeof v === 'number'; });
    if (values.length === 0) return '';
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = (max - min) || 1;
    var lastIndex = Math.max(1, series.length - 1);

    for (var i = 0; i < series.length; i += 1) {
      if (typeof series[i] !== 'number') continue;
      var x = (i / lastIndex) * 100;
      var y = 24 - ((series[i] - min) / span) * 22;
      points.push(x.toFixed(2) + ',' + y.toFixed(2));
    }
    return points.join(' ');
  }

  function sparkline(series, color) {
    var points = sparkPoints(series);
    if (!points) return null;
    return svg('svg', {
      viewBox: '0 0 100 26', width: 100, height: 26,
      preserveAspectRatio: 'none', 'aria-hidden': 'true',
    }, svg('polyline', {
      points: points, fill: 'none', stroke: color,
      'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke',
    }));
  }

  /** One bar per run, coloured by how that run moved against the one before. */
  function trendBars(trend, runs) {
    var series = trend.series || [];
    var numbers = series.filter(function (v) { return typeof v === 'number'; });
    var max = numbers.length ? Math.max.apply(null, numbers) : 1;
    var bars = [];

    for (var i = 0; i < series.length; i += 1) {
      var value = series[i];
      var run = runs[i] || {};
      if (typeof value !== 'number') {
        bars.push(el('span', {
          class: 'trend__bar',
          style: { height: '8px', background: (theme.palette || {}).border_soft },
          title: 'run #' + (run.number || '?') + ': not recorded',
        }));
        continue;
      }

      var previous = null;
      for (var b = i - 1; b >= 0; b -= 1) {
        if (typeof series[b] === 'number') { previous = series[b]; break; }
      }
      var change = previous === null ? 0 : value - previous;
      var direction = change === 0 ? 'flat'
        : (trend.lower_is_better ? change < 0 : change > 0) ? 'better' : 'worse';

      bars.push(el('span', {
        class: 'trend__bar',
        style: {
          height: Math.max(8, Math.round((value / (max || 1)) * 34)) + 'px',
          background: directionColor(direction),
        },
        title: 'run #' + (run.number || '?') + ': ' + value + (trend.unit || ''),
      }));
    }
    return bars;
  }

  // --- sections ------------------------------------------------------------

  function renderMasthead(meta) {
    return el('div', { class: 'masthead' }, [
      el('div', { class: 'masthead__identity' }, [
        el('span', { class: 'masthead__wordmark', text: meta.title }),
        el('span', { class: 'masthead__meta', text: meta.meta_display }),
      ]),
      meta.client_label ? el('span', { class: 'masthead__client', text: meta.client_label }) : null,
    ]);
  }

  function renderContents(navigation) {
    if (!navigation || navigation.length === 0) return null;
    var links = navigation.map(function (entry) {
      return el('a', { href: '#' + entry.id, text: entry.index + ' ' + entry.label });
    });
    return el('nav', { class: 'contents' },
      [el('span', { class: 'contents__label', text: 'CONTENTS' })].concat(links));
  }

  /** Sync failures are shown, not swallowed: a partial report says so. */
  function renderNotice(warnings) {
    if (!warnings || warnings.length === 0) return null;
    return el('div', { class: 'notice' }, [
      el('div', {
        class: 'notice__title',
        text: warnings.length === 1
          ? 'One source did not sync for this run; its section shows the last data collected.'
          : warnings.length + ' sources did not sync for this run; their sections show the last data collected.',
      }),
      el('ul', {}, warnings.map(function (w) { return el('li', { text: w }); })),
    ]);
  }

  function renderSummary(section) {
    if (!section || !section.kpis || section.kpis.length === 0) return null;

    var cards = section.kpis.map(function (kpi) {
      var color = directionColor((kpi.delta || {}).direction);
      var chart = sparkline(kpi.series || [], color);
      return el('div', { class: 'kpi' }, [
        el('div', { class: 'kpi__label', text: kpi.label }),
        el('div', { class: 'kpi__figure' }, [
          el('span', { class: 'kpi__value', text: kpi.display }),
          el('span', { class: 'kpi__unit', text: kpi.unit }),
        ]),
        el('div', { class: 'kpi__trend' }, [
          el('span', { class: 'kpi__delta', style: { color: color }, text: (kpi.delta || {}).display }),
          chart,
        ]),
      ]);
    });

    return el('section', { class: 'section', id: section.id }, [
      el('div', { class: 'section__eyebrow', style: { 'margin-bottom': '20px' },
        text: section.index + ' — ' + section.title }),
      el('div', { class: 'kpis' }, cards),
      section.note ? el('div', { class: 'section__note', text: section.note }) : null,
    ]);
  }

  function renderEvolution(section, runs) {
    if (!section || !section.enabled || !section.trends || section.trends.length === 0) return null;

    var rows = section.trends.map(function (trend) {
      return el('div', { class: 'trend' }, [
        el('div', {}, [
          el('div', { class: 'trend__name', text: trend.name }),
          el('div', { class: 'trend__hint', text: trend.hint }),
        ]),
        el('div', { class: 'trend__bars' }, trendBars(trend, runs)),
        el('div', { class: 'trend__current', text: (trend.current || {}).display }),
        el('div', {
          class: 'trend__delta',
          style: { color: directionColor((trend.delta || {}).direction) },
          text: (trend.delta || {}).display,
        }),
      ]);
    });

    var legend = (section.legend || []).map(function (item) {
      return item.direction
        ? el('span', { style: { color: directionColor(item.direction) }, text: '■ ' + item.label })
        : el('span', { text: item.label });
    });

    return el('section', { class: 'section', id: section.id }, [
      el('div', { class: 'section__head' }, [
        el('div', { class: 'section__eyebrow', text: section.index + ' — ' + section.title }),
        el('div', { class: 'section__aside', text: section.range_display }),
      ]),
      el('div', { class: 'panel' }, rows.concat([el('div', { class: 'legend' }, legend)])),
    ]);
  }

  var SORT_VALUES = {
    repository: function (pr) { return pr.repository; },
    title: function (pr) { return pr.title; },
    author: function (pr) { return (pr.author || {}).name; },
    age: function (pr) { return pr.age_hours; },
    changes: function (pr) { return (pr.changes || {}).lines_total; },
    commits: function (pr) { return (pr.commits || []).length; },
  };

  function renderPullRequests(section) {
    if (!section) return null;

    var sort = section.default_sort || { key: 'age', direction: 'desc' };
    // Every pull request starts collapsed; the summary rows are the overview.
    var open = {};

    var body = el('div', {});

    function draw() {
      clear(body);

      var items = (section.items || []).slice();
      var read = SORT_VALUES[sort.key];
      if (read) {
        items.sort(function (a, b) {
          var left = read(a);
          var right = read(b);
          var compared = typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left).localeCompare(String(right));
          return sort.direction === 'asc' ? compared : -compared;
        });
      }

      var headers = (section.columns || []).map(function (column) {
        var arrow = column.sortable && column.key === sort.key
          ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : '';
        var cell = el(column.sortable ? 'button' : 'div', {
          class: 'row__head' + (column.sortable ? ' row__head--sortable' : '')
            + (column.align === 'right' ? ' row__head--right' : ''),
          type: column.sortable ? 'button' : null,
          title: column.sortable ? 'Sort by ' + column.label : null,
        }, [column.label, el('span', { class: 'row__arrow', text: arrow })]);

        if (column.sortable) {
          cell.addEventListener('click', function () {
            sort = sort.key === column.key
              ? { key: column.key, direction: sort.direction === 'desc' ? 'asc' : 'desc' }
              : { key: column.key, direction: 'desc' };
            draw();
          });
        }
        return cell;
      });

      body.appendChild(el('div', { class: 'row row--head' }, headers));

      if (items.length === 0) {
        body.appendChild(el('div', { class: 'empty', style: { border: 'none' } },
          el('div', { class: 'empty__message', text: 'No pull requests to show.' })));
        return;
      }

      items.forEach(function (pr) { body.appendChild(renderPullRequest(pr, section, open, draw)); });
    }

    draw();

    var flags = (section.age_indicators || []).map(function (indicator) {
      return el('span', { style: { color: indicator.color }, text: '● ' + indicator.label });
    });

    return el('section', { class: 'section', id: section.id }, [
      el('div', { class: 'section__head', style: { 'margin-bottom': '6px' } }, [
        el('div', { class: 'section__title', text: section.title }),
        el('div', { class: 'flags' }, flags),
      ]),
      el('div', { class: 'section__headline' }, [
        el('span', { text: (section.headline || {}).display }),
        section.expand_hint ? el('span', { class: 'section__hint', text: section.expand_hint }) : null,
      ]),
      el('div', { class: 'table' }, el('div', { class: 'table__inner' }, body)),
    ]);
  }

  function renderPullRequest(pr, section, open, redraw) {
    var isOpen = !!open[pr.id];

    var summary = el('div', {
      class: 'row pr__summary', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen),
    }, [
      el('div', { class: 'mono', text: pr.repository }),
      el('div', {}, [
        el('div', { class: 'pr__title', text: pr.title }),
        el('div', { class: 'pr__branches', text: pr.branches_display }),
      ]),
      el('div', { class: 'mono', text: (pr.author || {}).name }),
      el('div', {
        class: 'mono mono--right',
        style: { color: ageColor(section, pr.age_indicator) },
        text: pr.age_display,
      }),
      el('div', { class: 'mono mono--right', text: (pr.changes || {}).display }),
      el('div', { class: 'mono mono--right', text: String((pr.commits || []).length) }),
      el('div', { class: 'pr__reviewers' }, (pr.reviewers || []).map(function (reviewer) {
        var color = indicatorColor(reviewer.indicator);
        return el('span', { class: 'chip', style: { color: color, 'border-color': color }, text: reviewer.label });
      })),
      el('div', { class: 'pr__chevron', text: isOpen ? '▲ less' : '▼ more' }),
    ]);

    function toggle() { open[pr.id] = !open[pr.id]; redraw(); }
    summary.addEventListener('click', toggle);
    summary.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });

    var children = [summary];

    var commits = (pr.commits || []).map(function (commit) {
      return el('div', { class: 'commit' }, [
        el('span', { class: 'commit__sha', text: commit.sha }),
        el('span', { class: 'commit__message', text: commit.message }),
        el('span', { class: 'commit__spacer' }),
        el('span', { class: 'commit__when', text: commit.when_display }),
      ]);
    });

    var facts = (pr.facts || []).map(function (fact) {
      return el('div', { class: 'fact' }, [
        el('span', { class: 'fact__key', text: fact.key }),
        el('span', { style: { color: indicatorColor(fact.indicator) }, text: fact.value }),
      ]);
    });

    children.push(el('div', { class: 'pr__detail', hidden: isOpen ? null : 'hidden' }, [
      el('div', {}, [
        el('div', { class: 'detail__heading', text: 'Commits — ' + (pr.commits || []).length }),
        el('div', { class: 'commits' }, commits.length ? commits
          : el('div', { class: 'commit__when', text: 'No commits recorded.' })),
      ]),
      el('div', {}, [
        el('div', { class: 'detail__heading', text: 'Review & changes' }),
        el('div', { class: 'facts' }, facts),
        pr.url ? el('div', { style: { 'margin-top': '10px', 'font-family': 'var(--mono)', 'font-size': '12px' } },
          el('a', { href: pr.url, target: '_blank', rel: 'noreferrer noopener', text: 'Open in Bitbucket ↗' })) : null,
      ]),
    ]));

    return el('div', { class: 'pr' }, children);
  }

  function renderCicd(section) {
    if (!section) return null;
    var outcomes = section.step_outcomes || {};

    var headers = (section.columns || []).map(function (column) {
      return el('div', {
        class: 'row__head' + (column.align === 'right' ? ' row__head--right' : ''),
        text: column.label,
      });
    });

    var rows = (section.items || []).map(function (pipeline) {
      var steps = (pipeline.steps || []).map(function (step) {
        var indicator = (outcomes[step.outcome] || {}).indicator || 'neutral';
        return el('span', {
          class: 'step',
          style: { background: indicatorColor(indicator) },
          title: step.name + ' — ' + step.outcome,
        });
      });

      return el('div', { class: 'row pipeline' }, [
        el('div', { class: 'mono', text: pipeline.repository }),
        el('div', {}, [
          el('div', { class: 'pipeline__name', text: pipeline.name }),
          el('div', { class: 'pipeline__branch', text: pipeline.branch }),
        ]),
        el('div', { class: 'mono', text: pipeline.triggered_by }),
        el('div', { class: 'pipeline__when', text: pipeline.when_display }),
        el('div', { class: 'mono mono--right', text: pipeline.duration_display }),
        el('div', {
          class: 'pipeline__outcome',
          style: { color: indicatorColor(pipeline.outcome_indicator) },
          text: pipeline.outcome,
        }),
        el('div', {}, [
          el('div', { class: 'steps' }, steps),
          el('div', {
            class: 'pipeline__note',
            style: { color: indicatorColor((pipeline.note || {}).indicator) },
            text: (pipeline.note || {}).display,
          }),
        ]),
      ]);
    });

    var inner = el('div', { class: 'table__inner' },
      [el('div', { class: 'row row--head' }, headers)].concat(
        rows.length ? rows : [el('div', { class: 'empty', style: { border: 'none' } },
          el('div', { class: 'empty__message', text: 'No pipelines in this window.' }))],
      ));

    return el('section', { class: 'section', id: section.id }, [
      el('div', { class: 'section__title', style: { 'margin-bottom': '6px' }, text: section.title }),
      el('div', { class: 'section__headline', text: (section.headline || {}).display }),
      el('div', { class: 'table table--cicd' }, inner),
    ]);
  }

  function renderTesting(section) {
    if (!section) return null;
    return el('section', { class: 'section', id: section.id }, [
      el('div', { class: 'section__title', style: { 'margin-bottom': '16px' }, text: section.title }),
      el('div', { class: 'empty' }, [
        el('div', { class: 'empty__message', text: (section.placeholder || {}).message }),
        el('div', { class: 'empty__hint', text: (section.placeholder || {}).hint }),
      ]),
    ]);
  }

  function renderJira(section) {
    if (!section || !section.items || section.items.length === 0) return null;

    var timeline = section.timeline || {};
    var query = '';
    // Tickets start collapsed; the heads read as a list until one is opened.
    var open = {};
    var groups = el('div', {});
    var count = el('span', { class: 'search__count', text: (section.totals || {}).display });

    function matches(ticket) {
      if (!query) return true;
      var fields = (section.search || {}).fields || ['key', 'title'];
      return fields.some(function (field) {
        return String(ticket[field] || '').toLowerCase().indexOf(query) >= 0;
      });
    }

    function draw() {
      clear(groups);
      var shown = 0;
      var total = 0;

      section.items.forEach(function (group) {
        var tickets = (group.tickets || []).filter(function (ticket) {
          total += 1;
          var hit = matches(ticket);
          if (hit) shown += 1;
          return hit;
        });

        groups.appendChild(el('div', { class: 'summary-group' }, [
          el('div', { class: 'summary-group__head' }, [
            el('div', { class: 'summary-group__title', text: group.title }),
            el('div', { class: 'summary-group__meta', text: group.count_display + ' · ' + group.jql }),
          ]),
          el('div', { class: 'tickets' }, tickets.map(function (ticket) {
            return renderTicket(ticket, section, timeline, open, draw);
          })),
          tickets.length === 0
            ? el('div', { class: 'summary-group__empty', text: group.empty_display })
            : null,
        ]));
      });

      count.textContent = query
        ? shown + ' of ' + total + ' tickets'
        : (section.totals || {}).display;
    }

    draw();

    var search = (section.search || {}).enabled
      ? el('div', { class: 'search' }, [
        el('input', {
          type: 'search',
          placeholder: (section.search || {}).placeholder || 'Search tickets…',
          'aria-label': 'Search tickets',
          oninput: function (event) { query = event.target.value.trim().toLowerCase(); draw(); },
        }),
        count,
      ])
      : null;

    return el('section', { class: 'section', id: section.id }, [
      el('div', { class: 'section__head', style: { 'margin-bottom': '4px', 'align-items': 'center' } }, [
        el('div', { class: 'section__eyebrow', text: section.index + ' — ' + section.title }),
        search,
      ]),
      section.expand_hint
        ? el('div', { class: 'section__headline' },
          el('span', { class: 'section__hint', text: section.expand_hint }))
        : null,
      groups,
    ]);
  }

  function renderTicket(ticket, section, timeline, open, redraw) {
    var typeIndicator = ((section.types || {})[ticket.type] || {}).indicator || 'neutral';
    var typeColor = indicatorColor(typeIndicator);
    var laneColors = theme.lanes || {};
    var total = (ticket.timeline || {}).total_hours || 1;

    var lanes = ((ticket.timeline || {}).lanes || []).map(function (lane) {
      var bars = (lane.segments || []).map(function (segment) {
        return el('div', {
          class: 'lane__bar',
          style: {
            left: ((segment.start_hours / total) * 100).toFixed(3) + '%',
            width: Math.max(1.5, (segment.duration_hours / total) * 100).toFixed(3) + '%',
            background: laneColors[lane.status] || indicatorColor('neutral'),
          },
          title: segment.title,
        });
      });

      var timeColor = lane.emphasis === 'empty' ? 'var(--text-faint)'
        : lane.emphasis === 'heavy' ? indicatorColor('problem') : 'var(--text-strong)';

      return el('div', { class: 'lane' }, [
        el('div', { class: 'lane__status', text: lane.status }),
        el('div', { class: 'lane__track' }, bars),
        el('div', { class: 'lane__who', text: lane.who, title: lane.who }),
        el('div', {
          class: 'lane__time' + (lane.emphasis === 'heavy' ? ' lane__time--heavy' : ''),
          style: { color: timeColor },
          text: lane.time_display,
        }),
      ]);
    });

    var isOpen = !!open[ticket.key];

    var head = el('div', {
      class: 'ticket__head', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen),
    }, [
      el('span', { class: 'ticket__type', style: { color: typeColor, 'border-color': typeColor }, text: ticket.type }),
      ticket.url
        ? el('a', { class: 'ticket__key', href: ticket.url, target: '_blank', rel: 'noreferrer noopener', text: ticket.key })
        : el('span', { class: 'ticket__key', text: ticket.key }),
      el('span', { class: 'ticket__title', text: ticket.title }),
      el('span', { class: 'ticket__spacer' }),
      el('span', { class: 'ticket__status', text: ticket.status }),
      el('span', { class: 'ticket__meta', text: ticket.meta_display }),
      el('span', { class: 'ticket__chevron', text: isOpen ? '▲ less' : '▼ more' }),
    ]);

    function toggle() { open[ticket.key] = !open[ticket.key]; redraw(); }
    head.addEventListener('click', function (event) {
      // The issue key is a link out to Jira; let it through instead of toggling.
      if (event.target.closest('a')) return;
      toggle();
    });
    head.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });

    return el('div', { class: 'ticket' }, [
      head,
      el('div', { class: 'ticket__body', hidden: isOpen ? null : 'hidden' }, [
        ticket.description ? el('div', { class: 'ticket__description', text: ticket.description }) : null,
        el('div', { class: 'ticket__timeline' }, [
          el('div', { class: 'lanes' }, lanes),
          el('div', { class: 'axis' }, [
            el('div', {}),
            el('div', { class: 'axis__scale' }, [
              el('span', { text: (ticket.timeline || {}).axis_start_display }),
              el('span', { text: (ticket.timeline || {}).axis_end_display }),
            ]),
            el('div', {}), el('div', {}),
          ]),
        ]),
      ]),
    ]);
  }

  function renderColophon(meta) {
    var footer = meta.footer || {};
    return el('div', { class: 'colophon' }, [
      el('span', { text: footer.left }),
      footer.right_href
        ? el('a', {
            class: 'colophon__link', text: footer.right, href: footer.right_href,
            target: '_blank', rel: 'noreferrer',
          })
        : el('span', { text: footer.right }),
    ]);
  }

  // --- mount ---------------------------------------------------------------

  function render() {
    applyTheme();
    var meta = doc.report || {};
    document.title = (meta.client_label ? meta.client_label + ' — ' : '') + (meta.title || 'lab34/health');

    var sheet = el('div', { class: 'sheet' }, [
      renderMasthead(meta),
      renderContents(doc.navigation),
      renderNotice(meta.warnings),
      renderSummary(doc.summary),
      renderEvolution(doc.evolution, doc.runs || []),
      renderPullRequests(doc.pull_requests),
      renderCicd(doc.cicd),
      renderTesting(doc.testing),
      renderJira(doc.jira_summaries),
      renderColophon(meta),
    ]);

    var page = el('div', { class: 'page' }, sheet);
    var root = document.getElementById('report');
    clear(root);
    root.appendChild(page);
  }

  try {
    render();
  } catch (error) {
    var root = document.getElementById('report');
    if (root) {
      root.textContent = 'Could not render this report: ' + error.message;
      root.setAttribute('style', 'padding:40px;font-family:monospace;color:#B3402F');
    }
    throw error;
  }
})();
