const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');

// Scopes: View and edit calendar, view and edit tasks
const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks'
];

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        return client;
    }
    // If no token, check if credentials exist before prompting auth
    try {
        await fs.access(CREDENTIALS_PATH);
    } catch (err) {
        console.warn('WARNING: credentials.json not found in root. Google integration disabled.');
        return null;
    }

    console.log('Initiating Google Auth...');
    client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });
    if (client.credentials) {
        await saveCredentials(client);
    }
    return client;
}

// --- CALENDAR FUNCTIONS ---

async function listUpcomingEvents(auth) {
    if (!auth) return "Google Calendar API not authorized.";
    const calendar = google.calendar({ version: 'v3', auth });
    try {
const now = new Date();
        const endOfRange = new Date();
        endOfRange.setDate(endOfRange.getDate() + 7); // Fetch seminggu ke depan
        endOfRange.setHours(23, 59, 59, 999);

        // 1. Get List of Calendars
        const calList = await calendar.calendarList.list();
        const calendars = calList.data.items || [{ id: 'primary', summary: 'Primary' }];

        // 2. Fetch events from ALL calendars in parallel
        const allEventsPromises = calendars.map(async (cal) => {
            try {
                const res = await calendar.events.list({
                    calendarId: cal.id,
                    timeMin: now.toISOString(),
                    timeMax: endOfRange.toISOString(),
                    maxResults: 20,
                    singleEvents: true,
                    orderBy: 'startTime',
                });
                return (res.data.items || []).map(ev => ({ ...ev, calSummary: cal.summary }));
            } catch (e) {
                return []; 
            }
        });

        const results = await Promise.all(allEventsPromises);
        let events = results.flat();

        // 3. Sort by start time mixed
        events.sort((a, b) => {
            const dateA = new Date(a.start.dateTime || a.start.date);
            const dateB = new Date(b.start.dateTime || b.start.date);
            return dateA - dateB;
        });

        // Limit total results
        events = events.slice(0, 15);

        if (!events || events.length === 0) {
            return 'No upcoming events found for the next 7 days.';
        }

        return events.map((event, i) => {
            const start = event.start.dateTime || event.start.date;
            const dateObj = new Date(start);
            // Format: [Rabu, 18 Februari 2026 09:00]
            const options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
            const dateStr = dateObj.toLocaleDateString('id-ID', options);
            const timeStr = start.includes('T') ? start.split('T')[1].substring(0, 5) : 'All Day';
            
            // Show calendar name if not primary
            const calTag = (event.calSummary && !event.calSummary.includes('@') && event.calSummary !== 'Primary') ? `[${event.calSummary}] ` : '';
            return `${i + 1}. ${calTag}[${dateStr} ${timeStr}] ${event.summary} (ID: ${event.id})`;
        }).join('\n');

    } catch (err) {
        console.error('The API returned an error: ' + err);
        return "Error fetching calendar.";
    }
}

async function getRawUpcomingEvents(auth, timeWindowMinutes = 15) {
    if (!auth) return [];
    const calendar = google.calendar({ version: 'v3', auth });
    try {
        const now = new Date();
        const future = new Date(now.getTime() + timeWindowMinutes * 60000);

        // 1. Get List of Calendars
        const calList = await calendar.calendarList.list();
        const calendars = calList.data.items || [{ id: 'primary' }];

        // 2. Fetch all
        const allEventsPromises = calendars.map(async (cal) => {
            try {
                const res = await calendar.events.list({
                    calendarId: cal.id,
                    timeMin: now.toISOString(),
                    timeMax: future.toISOString(),
                    maxResults: 10, // per calendar
                    singleEvents: true,
                    orderBy: 'startTime',
                });
                return res.data.items || [];
            } catch (e) { return []; }
        });

        const results = await Promise.all(allEventsPromises);
        return results.flat();

    } catch (err) {
        console.error('Error fetching raw events:', err);
        return [];
    }
}

async function createEvent(auth, summary, startTimeString, endTimeString) {
    if (!auth) return "Auth failed.";
    const calendar = google.calendar({ version: 'v3', auth });
    
    try {
        let startDateTime = new Date();
        if (!startTimeString) {
             // Default to next hour if no time specified (edge case)
             startDateTime.setHours(startDateTime.getHours() + 1, 0, 0);
        } else if (startTimeString.includes('T')) {
            startDateTime = new Date(startTimeString);
        } else if (startTimeString.includes(':')) {
            const [hours, minutes] = startTimeString.split(':');
            startDateTime.setHours(parseInt(hours), parseInt(minutes), 0);
        }

        let endDateTime = new Date(startDateTime);
        if (endTimeString) {
            if (endTimeString.includes('T')) {
                endDateTime = new Date(endTimeString);
            } else if (endTimeString.includes(':')) {
                const [hours, minutes] = endTimeString.split(':');
                endDateTime.setHours(parseInt(hours), parseInt(minutes), 0);
            }
        } else {
            // Default 1 hour duration
            endDateTime.setHours(startDateTime.getHours() + 1);
        }

        const event = {
            summary: summary || 'New Event',
            start: { dateTime: startDateTime.toISOString() },
            end: { dateTime: endDateTime.toISOString() },
        };

        const res = await calendar.events.insert({
            calendarId: 'primary',
            resource: event,
        });
        return `Event created: ${res.data.htmlLink}`;
    } catch (err) {
        return `Error creating event: ${err.message || err}`;
    }
}

async function deleteEvent(auth, eventId) {
    if (!auth) return "Auth failed.";
    const calendar = google.calendar({ version: 'v3', auth });
    try {
        await calendar.events.delete({
            calendarId: 'primary',
            eventId: eventId,
        });
        return `Event deleted: ${eventId}`;
    } catch (err) {
        return `Error deleting event: ${err.message || err}`;
    }
}

async function updateEvent(auth, eventId, summary, startTimeString, endTimeString) {
    if (!auth) return "Auth failed.";
    const calendar = google.calendar({ version: 'v3', auth });
    
    try {
        // Fetch existing event first to keep other fields if needed, but for now we just patch what we have
        const patchBody = {};
        if (summary) patchBody.summary = summary;
        
        if (startTimeString) {
             let startDateTime = new Date(startTimeString);
             // Logic parsing mirip createEvent, disederhanakan
             patchBody.start = { dateTime: startDateTime.toISOString() };
             
             let endDateTime = new Date(startDateTime);
             if (endTimeString) {
                 endDateTime = new Date(endTimeString);
             } else {
                 endDateTime.setHours(startDateTime.getHours() + 1);
             }
             patchBody.end = { dateTime: endDateTime.toISOString() };
        }

        const res = await calendar.events.patch({
            calendarId: 'primary',
            eventId: eventId,
            resource: patchBody,
        });
        return `Event updated: ${res.data.htmlLink}`;
    } catch (err) {
        return `Error updating event: ${err.message || err}`;
    }
}

// --- TASKS FUNCTIONS ---

async function listTasks(auth) {
    if (!auth) return "Google Tasks API not authorized.";
    const service = google.tasks({ version: 'v1', auth });
    try {
        const res = await service.tasks.list({
            tasklist: '@default',
            showCompleted: false,
            maxResults: 10,
        });
        const tasks = res.data.items;
        if (!tasks || tasks.length === 0) {
            return 'No pending tasks.';
        }
        return tasks.map((task, i) => `${i + 1}. ${task.title} (Due: ${task.due ? task.due.substring(0, 10) : 'No Date'}) (ID: ${task.id})`).join('\n');
    } catch (err) {
        return "Error fetching tasks.";
    }
}

async function createTask(auth, title, dueDateString) {
    if (!auth) return "Auth failed.";
    const service = google.tasks({ version: 'v1', auth });
    
    const task = {
        title: title
    };
    if (dueDateString) {
        // Tasks API expects RFC 3339 timestamp
        task.due = new Date(dueDateString).toISOString();
    }

    try {
        const res = await service.tasks.insert({
            tasklist: '@default',
            resource: task,
        });
        return `Task created: ${res.data.title}`;
    } catch (err) {
        return `Error creating task: ${err}`;
    }
}

async function deleteTask(auth, taskId) {
    if (!auth) return "Auth failed.";
    const service = google.tasks({ version: 'v1', auth });
    try {
        await service.tasks.delete({
            tasklist: '@default',
            task: taskId,
        });
        return `Task deleted: ${taskId}`;
    } catch (err) {
        return `Error deleting task: ${err.message || err}`;
    }
}

async function updateTask(auth, taskId, title, dueDateString) {
    if (!auth) return "Auth failed.";
    const service = google.tasks({ version: 'v1', auth });
    
    const taskBody = {};
    if (title) taskBody.title = title;
    if (dueDateString) taskBody.due = new Date(dueDateString).toISOString();
    
    try {
        const res = await service.tasks.patch({
            tasklist: '@default',
            task: taskId,
            resource: taskBody,
        });
        return `Task updated: ${res.data.title}`;
    } catch (err) {
        return `Error updating task: ${err.message || err}`;
    }
}

module.exports = {
    authorize,
    listUpcomingEvents,
    getRawUpcomingEvents,
    createEvent,
    deleteEvent,
    updateEvent,
    listTasks,
    createTask,
    deleteTask,
    updateTask
};
