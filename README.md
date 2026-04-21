# Leave Bot - Team Leave Management System

A web-based leave management system for tracking Annual Leave (AL), Earned Leave (EL), and managing team schedules.

## Features

- **Half-day AL support** - AM/PM options for Annual Leave
- **Leave validation** - Enforces 6 house rules for leave requests
- **Calendar view** - Visual representation of team leave
- **Real-time updates** - WebSocket-based live updates
- **Public holiday support** - Automatic handling of HK public holidays
- **Buddy system** - Ensures team coverage with buddy requirements

## House Rules

1. Rita AL conflict prevention
2. Other colleagues AL vs Rita AL conflict
3. EL restrictions on Rita AL dates
4. Max 2x AL per working day
5. Buddy availability check
6. Max 2x EL per day
7. Max 3x AL/EL per day
8. No duplicate submissions

## Special Cases

- **Weekend AL** - Not counted towards daily AL limits
- **Public Holiday AL** - Not counted towards daily AL limits
- **EL blocking** - Cannot submit EL if AL exists on same day

## Deployment

Deployed on Render.com for always-on availability.

## Tech Stack

- Node.js + Express
- Vanilla JavaScript + HTML/CSS
- WebSocket for real-time updates
- JSON file storage
