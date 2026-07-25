# OnTrack CLI

The OnTrack CLI context gives students and teaching staff a terminal view of an OnTrack deployment while preserving OnTrack's own domain language.

## Language

**OnTrack Deployment**:
A hosted Doubtfire/OnTrack installation with its own authentication method, users, Units, and Projects.
_Avoid_: Server, site

**Authenticated Session**:
A verified user identity and access token for one OnTrack Deployment, together with the source that supplied the credentials.
_Avoid_: Login state, cached user

**Unit**:
The teaching period offering that owns Task Definitions, grades, schedules, and Teaching Roles.
_Avoid_: Course, class

**Teaching Role**:
A staff member's named relationship to a Unit, such as tutor, convenor, or observer.
_Avoid_: Membership, team role

**Project**:
A student's enrolment and progress record within one Unit; it owns that student's Tasks, target grade, and portfolio state.
_Avoid_: Workspace, course project

**Task Definition**:
The Unit-owned description, requirements, default dates, and grading rules shared by every corresponding Task.
_Avoid_: Assignment template, task template

**Task**:
A Project-specific progress and submission record for one Task Definition.
_Avoid_: Assignment, task instance

**Task Status**:
The current OnTrack workflow state of a Task, including whether it is active, submitted, under discussion, or final.
_Avoid_: State flag, progress label

**Task Schedule**:
The effective start, target, and deadline dates for a Task after applying Project-specific dates, target-grade dates, extensions, and special consideration.
_Avoid_: Due date, task dates

**Project Snapshot**:
An interpreted view of one Project joined with its Unit, Task Definitions, Tasks, Task Schedules, grades, and statuses at a point in time.
_Avoid_: Project detail response, merged task rows

**Submission**:
The files and assessment metadata offered for a Task, including processing state and history.
_Avoid_: Upload, attachment
