async function sendEmail({ from, to, subject, body, env }) {
  const { MAILGUN_DOMAIN_NAME, MAILGUN_API_KEY } = env;
  const url = `https://api.mailgun.net/v3/${MAILGUN_DOMAIN_NAME}/messages`;

  const formData = new FormData();
  formData.append("from", from);
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("html", body);

  const authHeader = "Basic " + btoa("api:" + MAILGUN_API_KEY);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
    },
    body: formData,
  });

  const data = await response.json();

  if (response.ok) {
    return new Response("Email sent successfully!", { status: 200 });
  } else {
    console.error("Error sending email:", data);
    return new Response("Error sending email", { status: 500 });
  }
}

async function getAccountDetails(accountId, authHeader, jiraDomain) {
  const url = `https://${jiraDomain}/rest/api/3/user?accountId=${accountId}`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `Failed to get displayName for ${accountId}. Status: ${response.status} ${response.statusText}`,
        errorBody
      );
      return { accountId: accountId, displayName: accountId };
    }

    const data = await response.json();
    return {
      accountId: data.accountId || accountId,
      displayName: data.displayName || accountId,
    };
  } catch (error) {
    console.error(
      `Exception when fetching account details for ${accountId}:`,
      error
    );
    return { accountId: accountId, displayName: accountId };
  }
}

function buildHtmlTable(accountName, lines, total) {
  if (!lines.length) {
    return `
      <h3>Summary of Hours - ${accountName}: ${total}</h3>
    `;
  }

  const sortedLines = lines.sort((a, b) => {
    const dateA = a.split(" | ")[1];
    const dateB = b.split(" | ")[1];
    return new Date(dateA) - new Date(dateB);
  });

  const rows = sortedLines
    .map((line) => {
      const [issueKey, date, time, comment] = line.split(" | ");
      return `<tr>
      <td>${formatDateMMDDYYYY(date)}</td>
      <td>${issueKey}</td>
      <td>${comment}</td>
      <td>${time}</td>
    </tr>`;
    })
    .join("");

  return `
    <h3>Summary of Hours - ${accountName}: ${total}</h3>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
      <tr>
        <th>Date</th>
        <th>Task/Ticket ID</th>
        <th>Description</th>
        <th>Hours Spent</th>
      </tr>
      ${rows}
    </table><br/>
  `;
}

function formatMonth(date) {
  const d = new Date(date);
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${month} ${year}`;
}

function formatDateMMDDYYYY(date) {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const year = d.getFullYear();
  return `${month}/${day}/${year}`;
}

function getCurrentMonthRange() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));

  const fromDate = start.toISOString().split("T")[0];
  const toDate = end.toISOString().split("T")[0];
  return { fromDate, toDate };
}

async function fetchWorklogData({ fromDate, toDate, env }) {
  const { JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN, ACCOUNT_IDS } = env;

  if (!JIRA_DOMAIN || !JIRA_EMAIL || !JIRA_API_TOKEN || !ACCOUNT_IDS) {
    console.error("Missing Jira credentials or ACCOUNT_IDS.");
    throw new Error("Missing Jira credentials or ACCOUNT_IDS.");
  }

  const authHeader = "Basic " + btoa(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`);

  let accountsArray = [];
  try {
    accountsArray = JSON.parse(ACCOUNT_IDS);
    if (!Array.isArray(accountsArray) || accountsArray.length === 0) {
      console.error(
        "ACCOUNT_IDS is not a valid JSON array string or is empty:",
        ACCOUNT_IDS
      );
      return [];
    }
  } catch (e) {
    console.error(
      "Failed to parse ACCOUNT_IDS JSON string in fetchWorklogData:",
      ACCOUNT_IDS,
      e
    );
    throw new Error(`Failed to parse ACCOUNT_IDS JSON string: ${e.message}`);
  }

  const allWorklogEntries = [];

  for (const accountId of accountsArray) {
    const accountDetails = await getAccountDetails(
      accountId,
      authHeader,
      JIRA_DOMAIN
    );
    const accountName = accountDetails.displayName;

    // --- MODIFICATION START ---
    // Construct the JQL query to filter issues by worklog author AND worklog date range
    const jqlQuery = `worklogAuthor="${accountId}" AND worklogDate >= "${fromDate}" AND worklogDate <= "${toDate}"`;
    const searchUrl = `https://${JIRA_DOMAIN}/rest/api/3/search?jql=${encodeURIComponent(
      jqlQuery
    )}&fields=key,summary&maxResults=100`;
    // --- MODIFICATION END ---

    try {
      const searchResp = await fetch(searchUrl, {
        headers: { Authorization: authHeader, Accept: "application/json" },
      });
      if (!searchResp.ok) {
        const errorBody = await searchResp.text();
        console.error(
          `Failed to search issues for ${accountId}. Status: ${searchResp.status} ${searchResp.statusText}`,
          errorBody
        );
        continue;
      }
      const issues = await searchResp.json();

      if (
        !issues ||
        !Array.isArray(issues.issues) ||
        issues.issues.length === 0
      ) {
        continue;
      }

      for (const issue of issues.issues) {
        const issueKey = issue.key;
        const issueSummary = issue.fields?.summary || "No Summary";

        const worklogUrl = `https://${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/worklog`;
        try {
          const worklogResp = await fetch(worklogUrl, {
            headers: { Authorization: authHeader, Accept: "application/json" },
          });
          if (!worklogResp.ok) {
            const errorBody = await worklogResp.text();
            console.error(
              `Failed to fetch worklogs for issue ${issueKey}. Status: ${worklogResp.status} ${worklogResp.statusText}`,
              errorBody
            );
            continue;
          }

          const worklogs = await worklogResp.json();

          if (
            !worklogs ||
            !Array.isArray(worklogs.worklogs) ||
            worklogs.worklogs.length === 0
          ) {
            continue;
          }

          for (const log of worklogs.worklogs) {
            // --- KEEPING BACKEND FILTERING ---
            // This is still necessary because the /worklog endpoint returns ALL worklogs for the issue.
            // We must re-filter by author and date to be absolutely sure.
            if (!log.author || log.author.accountId !== accountId) {
              continue;
            }

            const startedDate = log.started?.split("T")[0];
            if (!startedDate) {
              console.error(
                `Worklog entry for ${issueKey} is missing started date. Skipping.`
              );
              continue;
            }

            if (startedDate < fromDate || startedDate > toDate) {
              continue;
            }
            // --- END OF KEEPING BACKEND FILTERING ---

            const seconds = log.timeSpentSeconds;
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const comment =
              log.comment?.content?.[0]?.content?.[0]?.text ||
              issueSummary ||
              "No comment provided";

            allWorklogEntries.push({
              issueKey: issueKey,
              date: startedDate,
              timeSpent: `${hours}h ${minutes}m`,
              timeSpentSeconds: seconds,
              description: comment,
              accountName: accountName,
            });
          }
        } catch (worklogError) {
          console.error(
            `Exception when fetching worklogs for issue ${issueKey}:`,
            worklogError
          );
          continue;
        }
      }
    } catch (searchError) {
      console.error(
        `Exception when searching issues for accountId ${accountId}:`,
        searchError
      );
      continue;
    }
  }

  allWorklogEntries.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  return allWorklogEntries;
}

async function generateReport({
  fromDate,
  toDate,
  env,
  isMonthlyReport = false,
}) {
  const { DAILY_EMAIL_TO, EMAIL_TO, EMAIL_FROM } = env;

  let worklogData = [];
  try {
    worklogData = await fetchWorklogData({ fromDate, toDate, env });
  } catch (error) {
    console.error("Error fetching worklog data for report generation:", error);
    return;
  }

  let emailHtml = "";
  if (isMonthlyReport) {
    emailHtml = `<h2>📝 Monthly Worklog Report – ${formatMonth(fromDate)}</h2>`;
  } else {
    emailHtml =
      fromDate === toDate
        ? `<h2>📝 Worklog report for ${formatDateMMDDYYYY(fromDate)}</h2>`
        : `<h2>📊 Weekly Worklog (${formatDateMMDDYYYY(
            fromDate
          )} → ${formatDateMMDDYYYY(toDate)})</h2>`;
  }

  const dataByAccount = worklogData.reduce((acc, entry) => {
    if (!acc[entry.accountName]) {
      acc[entry.accountName] = { lines: [], totalSeconds: 0 };
    }
    const parts = entry.timeSpent.split("h ");
    const hours = parseInt(parts[0]);
    const minutes = parseInt(parts[1].replace("m", ""));
    const seconds = hours * 3600 + minutes * 60;

    acc[entry.accountName].lines.push(
      `${entry.issueKey} | ${entry.date} | ${entry.timeSpent} | ${entry.description}`
    );
    acc[entry.accountName].totalSeconds += seconds;
    return acc;
  }, {});

  for (const accountName in dataByAccount) {
    if (dataByAccount.hasOwnProperty(accountName)) {
      const { lines, totalSeconds } = dataByAccount[accountName];
      const totalH = Math.floor(totalSeconds / 3600);
      const totalM = Math.floor((totalSeconds % 3600) / 60);
      const totalTimeFormatted = `${totalH}h${totalM}m`;

      const tableHtml = buildHtmlTable(accountName, lines, totalTimeFormatted);
      emailHtml += tableHtml;
    }
  }

  if (worklogData.length === 0) {
    emailHtml +=
      "<p>No worklogs found for the specified date range and accounts.</p>";
  }

  let subjectStr = "";
  if (isMonthlyReport) {
    subjectStr = `Monthly Worklog Report – ${formatMonth(fromDate)}`;
  } else {
    subjectStr =
      fromDate === toDate
        ? `📝 Worklog report for ${formatDateMMDDYYYY(fromDate)}`
        : `Weekly Worklog (${formatDateMMDDYYYY(
            fromDate
          )} → ${formatDateMMDDYYYY(toDate)})`;
  }

  const recipient = fromDate === toDate ? DAILY_EMAIL_TO : EMAIL_TO;

  await sendEmail({
    from: EMAIL_FROM,
    to: recipient,
    subject: subjectStr,
    body: emailHtml,
    env,
  });
}

function getPreviousMonthRange() {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const fromDate = start.toISOString().split("T")[0];
  const toDate = end.toISOString().split("T")[0];
  return { fromDate, toDate };
}

function getPreviousWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();

  const mondayLastWeek = new Date(now);
  mondayLastWeek.setUTCDate(now.getUTCDate() - dayOfWeek - 6);

  const sundayLastWeek = new Date(mondayLastWeek);
  sundayLastWeek.setUTCDate(mondayLastWeek.getUTCDate() + 6);

  const format = (d) => d.toISOString().split("T")[0];

  return {
    fromDate: format(mondayLastWeek),
    toDate: format(sundayLastWeek),
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/get-report-data") {
      const queryFromDate = url.searchParams.get("fromDate");
      const queryToDate = url.searchParams.get("toDate");

      let reportFromDate, reportToDate;

      const { fromDate: currentMonthStart, toDate: currentMonthEnd } =
        getCurrentMonthRange();

      reportFromDate = queryFromDate || currentMonthStart;
      reportToDate = queryToDate || currentMonthEnd;

      try {
        const worklogData = await fetchWorklogData({
          fromDate: reportFromDate,
          toDate: reportToDate,
          env,
        });

        return new Response(JSON.stringify(worklogData), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      } catch (error) {
        console.error("Error in /get-report-data endpoint:", error);
        return new Response(
          JSON.stringify({ error: error.message, stack: error.stack }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          }
        );
      }
    }

    if (url.pathname === "/trigger-report") {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayFormatted = yesterday.toISOString().split("T")[0];
      await generateReport({
        fromDate: yesterdayFormatted,
        toDate: yesterdayFormatted,
        env,
      });
      return new Response("✅ Manual daily report sent.");
    }

    if (url.pathname === "/trigger-weekly-report") {
      const { fromDate, toDate } = getPreviousWeekRange();
      await generateReport({ fromDate, toDate, env });
      return new Response("✅ Manual weekly report sent.");
    }

    if (url.pathname === "/trigger-monthly-report") {
      const { fromDate, toDate } = getPreviousMonthRange();
      await generateReport({ fromDate, toDate, env, isMonthlyReport: true });
      return new Response("✅ Manual monthly report sent.");
    }

    return new Response("Hello from Worker!");
  },

  async scheduled(event, env, ctx) {
    const now = new Date();
    const isMonday = now.getUTCDay() === 1;
    const isFirstDayOfMonth = now.getUTCDate() === 1;

    let fromDate, toDate;
    let isMonthlyReport = false;
    let reportType = "Daily";

    if (isFirstDayOfMonth) {
      ({ fromDate, toDate } = getPreviousMonthRange());
      isMonthlyReport = true;
      reportType = "Monthly";
    } else if (isMonday) {
      ({ fromDate, toDate } = getPreviousWeekRange());
      reportType = "Weekly";
    } else {
      const yesterday = new Date(now);
      yesterday.setUTCDate(now.getUTCDate() - 1);
      const yesterdayFormatted = yesterday.toISOString().split("T")[0];
      fromDate = toDate = yesterdayFormatted;
      reportType = "Daily";
    }

    await generateReport({ fromDate, toDate, env, isMonthlyReport });
  },
};
