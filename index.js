const _ = require('lodash');
const path = require('path');
const Promise = require('bluebird');
const moment = require('moment');
require('moment-range');
const GitHub = require('octocat');

// Setup command line options
const { argv } = require('yargs')
  .usage(
    'Usage: $0 <file> <GITHUB_TOKEN> [options]\n\nBy default GITHUB_TOKEN is read from env variable.',
  )
  .demand(1)
  .boolean('g')
  .alias('g', 'goals')
  .describe('g', 'Include milestone goals in the roadmap')
  .boolean('s')
  .alias('s', 'summary')
  .describe('s', 'Include milestone summaries in the roadmap')
  .alias('p', 'progressBars')
  .describe('p', 'Show progress with images instead of text')
  .alias('l', 'log')
  .describe('l', 'Log level: DEBUG|ERROR')
  .default('l', 'ERROR')
  .nargs('l', 1)
  .example('$0 roadmap.conf.js', 'Output a generated roadmap')
  .example(
    '$0 roadmap.conf.js > ROADMAP.md',
    'Output the generated roadmap to ROADMAP.md',
  )
  .example('$0 roadmap.conf.js -gs', 'Generate detailed roadmap')
  .help('h')
  .alias('h', 'help')
  .describe('h', 'Show help');

// Setup logging
const Logger = require('logplease');

const logger = Logger.create('roadmap-generator', {
  color: Logger.Colors.Green,
});
require('logplease').setLogLevel(argv.log || 'ERROR');

// Projects configuration
const roadmap = require(path.resolve(argv._[0]));
// TODO make sure these exist
const { projects } = roadmap;
const { organization } = roadmap;
const milestonesStartDate = roadmap.milestonesStartDate || moment.now();
const milestonesEndDate = roadmap.milestonesEndDate || moment.now();

// Visuals configuration
const symbols = {
  // Issue status
  done: '✔', // or ✅ or '**DONE**'
  notDone: '❌', // or 'OPEN'
  // Milestone status
  open: '🚀', // or 🔔 or ''
  closed: '⭐', // or ''
  // Milestone details
  progress: '📉', // or 'Progress'
  date: '📅', // or 'Estimated Completion'
};

/* GITHUB */

// Github token
const token = process.env.GITHUB_TOKEN || argv._[1] || null;
if (!token) {
  logger.error('Error: GITHUB_TOKEN not provided!');
  process.exit(1);
}

// Github API client
const client = new GitHub({ token });

/* Github data transformation functions */

function getMilestonesListForProject(client, project) {
  logger.log(`-- Generate milestones list for '${project.name}' --`);
  const res = _.cloneDeep(project);
  return Promise.map(
    project.repos,
    (repo) => {
      logger.log(`Get milestones from ${repo}`);
      return client
        .get(`/repos/${repo}/milestones`, {
          state: 'all',
          sort: 'due_on',
          direction: 'asc',
        })
        .then((res) => res.body);
    },
    { concurrency: 16 },
  )
    .then((results) => {
      const milestones = {};
      // Sort milestones: open ones first (next due date first), then closed milestones
      let sorted = _.uniq(_.flatten(results));
      sorted = _.orderBy(sorted, ['state', 'due_on'], ['desc', 'asc']);

      sorted.forEach((e) => {
        // Filter out milestones that are not within given date range
        const startDate = moment.utc(milestonesStartDate);
        const endDate = moment.utc(milestonesEndDate);
        const range = moment.range(startDate, endDate);
        const due = moment.utc(e.due_on);
        if (due.within(range)) {
          milestones[e.title] = {
            title: e.title,
            description: e.description,
            due_on: e.due_on,
            html_url: e.html_url,
            state: e.state,
            updated: e.updated_at,
            issues: [],
          };
        }
      });
      return milestones;
    })
    .then((milestones) => {
      res.milestones = milestones;
      return res;
    });
}

function getAllMilestoneIssues(client, project) {
  logger.log(`-- Generate issues list for '${project.name}' --`);
  const result = _.cloneDeep(project);
  return Promise.map(
    project.repos,
    (repo) => {
      logger.log(`Get issues from ${repo}`);
      return client
        .get(`/repos/${repo}/issues`, { state: 'all', per_page: '20000' })
        .then((res) => {
          const issues = res.body;
          logger.log(`Found ${issues.length} issues in ${repo}`);
          return { repo, issues };
        });
    },
    { concurrency: 16 },
  ).then((res) => {
    res.forEach((repo) => {
      repo.issues.forEach((e) => {
        if (e.milestone) {
          const milestone = result.milestones[e.milestone.title];
          if (milestone) {
            milestone.issues.push({
              title: e.title,
              body: e.body,
              repo: repo.repo,
              html_url: e.html_url,
              repository_url: e.repository_url,
              state: e.state,
              labels: e.labels,
              updated: e.updated_at,
            });
          }
        }
      });
    });
    return result;
  });
}

function getMilestoneProgress(project) {
  const res = _.cloneDeep(project);
  res.milestones = Object.keys(project.milestones).map((k) => {
    const ms = _.cloneDeep(project.milestones[k]);
    const total = ms.issues.length;
    const open = ms.issues.filter((b) => b.state === 'open').length;
    const closed = ms.issues.filter((b) => b.state !== 'open').length;
    ms.open_issues = open;
    ms.total_issues = total;
    ms.closed_issues = closed;
    return ms;
  });
  return res;
}

/* Markdown output functions */

const nameToAnchor = (name) => name.split(' ').join('-').toLowerCase();

function generateMilestonesSummary(project, options) {
  const opts = options || { useVisualProgressBars: false };

  let str = '#### Milestone Summary\n\n';
  str += '| Status | Milestone | Goals | ETA | Last Updated |\n';
  str += '| :---: | :--- | :---: | :---: | :---: |\n';

  str += Object.keys(project.milestones)
    .map((k, i) => {
      const m = project.milestones[k];
      const progressPercentage = Math.floor(
        (m.closed_issues / Math.max(m.closed_issues + m.open_issues, 1)) * 100,
      );

      let milestone = '';
      milestone += `| ${m.state === 'open' ? symbols.open : symbols.closed} `;
      milestone += `| **[${m.title}](#${nameToAnchor(m.title)})** `;

      if (opts.useVisualProgressBars) milestone += `| ![Progress](http://progressed.io/bar/${progressPercentage}) `;
      else milestone += `| ${m.closed_issues} / ${m.total_issues} `;

      milestone += `| ${new Date(m.due_on).toDateString()} `;
      milestone += `| ${new Date(m.updated).toDateString()} `;
      milestone += '|\n';
      return milestone;
    })
    .join('');
  str += '\n';

  return str;
}

/// /////////
function getTextByLine(target, line) {
  const text = target;
  return String(text.trim().split('\n')[line - 1]);
}
function stringToDate(_date, _format, _delimiter) {
  const formatLowerCase = _format.toLowerCase();
  const formatItems = formatLowerCase.split(_delimiter);
  const dateItems = _date.split(_delimiter);
  const monthIndex = formatItems.indexOf('mm');
  const dayIndex = formatItems.indexOf('dd');
  const yearIndex = formatItems.indexOf('yyyy');
  let month = parseInt(dateItems[monthIndex]);
  month -= 1;
  const formatedDate = new Date(dateItems[yearIndex], month, dateItems[dayIndex]);
  return formatedDate;
}
/// /////////

function dataToMarkdown(projects, options) {
  const opts = options || {
    listGoalsPerMilestone: false,
    displayProjectName: true,
    useVisualProgressBars: false,
  };

  const res = projects.map((project) => {
    let str = opts.displayProjectName ? `## ${project.name}\n\n` : '';

    // Status section
    if (project.links && project.links.status) str += project.links.status;

    // Milestone summary
    if (opts.includeMilestoneSummary) {
      str += generateMilestonesSummary(project, options);
    }

    // Milestones header
    if (!opts.displayProjectName) str += '## Milestones and Goals\n\n';

    // Milestones for the project
    str += Object.keys(project.milestones)
      .map((k, i) => {
        const m = project.milestones[k];
        const progressPercentage = Math.floor(
          (m.closed_issues / Math.max(m.closed_issues + m.open_issues, 1))
            * 100,
        );
        const t = m.html_url.split('/');
        t.pop();
        t.pop();

        let milestone = `#### ${m.title}\n\n`;
        milestone += `> ${m.description}\n\n`;

        milestone
          += `${m.state === 'open' ? symbols.open : symbols.closed
          } &nbsp;**${m.state.toUpperCase()}** &nbsp;&nbsp;`;
        milestone += `${symbols.progress} &nbsp;&nbsp;**${m.closed_issues} / ${m.total_issues}** goals completed **(${progressPercentage}%)** &nbsp;&nbsp;`;
        milestone += `${symbols.date} &nbsp;&nbsp;**${new Date(
          m.due_on,
        ).toDateString()}**\n\n`;

        if (opts.listGoalsPerMilestone) {
          milestone += '| Status | Goal | Labels | Summary | Date |\n';
          milestone += '| :---: | :--- | --- | :--- | :---: |\n';
          milestone
            += `${m.issues
              .map((issue, idx) => {
                let text = `| ${
                  issue.state === 'open' ? symbols.notDone : symbols.done
                } `;
                text += `| [${issue.title.replace(/\|/g, '-')}](${
                  issue.html_url
                }) `;
                text
                  += issue.labels.length > 0
                    ? `|${
                      issue.labels
                        .map((label) => `\`${label.name}\``)
                        .join(', ')}`
                    : '| ';
                text += `| ${getTextByLine(issue.body, 3).split('|')[2]} `;
                const dateString = new Date(
                  getTextByLine(issue.body, 3).split('|')[1],
                ).toDateString();
                text += `| ${dateString} |\n`;
                return text;
              })
              .join('')}\n`;
        } else {
          milestone += `See [milestone goals](https://${
            roadmap.targetRepo
          }?milestone=${encodeURIComponent(
            m.title,
          )}) for the list of goals this milestone has.`;
        }

        milestone += '\n';
        return milestone;
      })
      .join('');

    return str;
  });
  return res.join('');
}

// WIP
function generateTableOfContents(projects) {
  let res = '';
  res += projects
    .map((e, i) => {
      let str = `${i + 1}. [${e.name}](${nameToAnchor(e.name)})\n`;
      str += e.milestones
        ? Object.keys(e.milestones)
          .map((k) => {
            const m = e.milestones[k];
            return `  - [${m.title}](${nameToAnchor(m.title)})\n`;
          })
          .join('')
        : '';

      return str;
    })
    .join('');

  return res;
}

/* Main */

Promise.all(
  projects.map((project, i) => getMilestonesListForProject(client, project)),
)
  .then((res) => Promise.all(res.map((e) => getAllMilestoneIssues(client, e))))
  .then((projectsWithIssues) => projectsWithIssues.map((project) => getMilestoneProgress(project)))
  .then((final) => {
    /* FINAL OUTPUT */
    logger.debug('Output:');

    console.log(`# ${organization} - Account Status`);
    console.log('');
    console.log(
      `This document describes the current status and the upcoming milestones of the ${organization} project.`,
    );
    console.log('');
    console.log(`*Updated: ${new Date().toUTCString()}*`);
    console.log('');

    // console.log("## Table of Contents\n")
    // console.log(generateTableOfContents(projectsWithIssues))

    // console.log("## Projects")
    // console.log("")
    // final.forEach((project) => console.log(`- [${project.name}](#${project.name})`))
    // console.log("")

    const output = dataToMarkdown(final, {
      displayProjectName: projects.length > 1,
      listGoalsPerMilestone: argv.goals,
      includeMilestoneSummary: argv.summary,
      useVisualProgressBars: argv.progressBars,
    });
    console.log(output);
  })
  .catch((e) => logger.error(e));
