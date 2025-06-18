// Ensure Firebase objects are available globally from index.html script
// These are window.firebaseApp, window.firebaseAuth, window.firebaseDb, window.appGlobalId, window.initialAuthToken
// And window.currentUserUid will be set after authentication.

document.addEventListener('DOMContentLoaded', () => {
    const taskLists = {
        marketing: document.getElementById('marketing-tasks'),
        gamedev: document.getElementById('gamedev-tasks'),
        personal: document.getElementById('personal-tasks'),
        archive: document.getElementById('archive-tasks')
    };

    const categories = document.querySelectorAll('.category');
    const addTaskButtons = document.querySelectorAll('.add-task-btn');
    const messageBox = document.getElementById('message-box');

    let db; // Firestore database instance
    let auth; // Firebase Auth instance
    let currentUserUid; // Current authenticated user's UID
    let appGlobalId; // App ID from Canvas environment

    // Local cache for tasks, populated by Firestore's onSnapshot
    let tasksCache = {}; 

    const PRIORITY_ORDER = {
        'important': 1,
        'normal': 2,
        'low': 3
    };

    // Wait for Firebase to be initialized and user authenticated
    // Use a short delay if window.firebaseApp etc. are not immediately available
    const initFirebaseInterval = setInterval(() => {
        // Ensure all required window properties are available and user UID is set
        if (window.firebaseApp && window.firebaseAuth && window.firebaseDb && window.appGlobalId && window.currentUserUid) {
            clearInterval(initFirebaseInterval); // Stop trying once initialized
            db = window.firebaseDb;
            auth = window.firebaseAuth;
            appGlobalId = window.appGlobalId;
            currentUserUid = window.currentUserUid; // Get UID from window after auth in index.html

            // Now that Firebase is ready and user is authenticated, set up Firestore listener
            setupFirestoreListeners();
        } else {
            // console.log("Waiting for Firebase initialization and user authentication...");
            // Display loading state or message if needed
        }
    }, 100); // Check every 100ms

    // --- Utility Functions ---
    /**
     * Displays a custom message box with a given message and type (success/error).
     * @param {string} message - The message to display.
     * @param {string} [type='success'] - The type of message ('success' or 'error').
     */
    function showMessage(message, type = 'success') {
        messageBox.textContent = message;
        messageBox.className = 'custom-message-box show'; // Reset and show
        if (type === 'error') {
            messageBox.style.backgroundColor = '#e74c3c'; // Red for error
        } else {
            messageBox.style.backgroundColor = '#4CAF50'; // Green for success
        }
        setTimeout(() => {
            messageBox.classList.remove('show');
        }, 3000); // Hide after 3 seconds
    }

    /**
     * Converts plain text URLs into clickable HTML anchor tags.
     * @param {string} text - The input text possibly containing URLs.
     * @returns {string} Text with URLs converted to clickable links.
     */
    function convertUrlsToLinks(text) {
        // Regex to find URLs (http/https)
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        return text.replace(urlRegex, (url) => {
            return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
        });
    }

    // --- Task HTML Generation ---
    /**
     * Creates a new task HTML element based on provided task data.
     * @param {object} taskData - An object containing task properties (id, name, status, notes, deadline, priority, originalCategory).
     * @returns {HTMLLIElement} The created task list item element.
     */
    function createTaskElement(taskData) {
        const li = document.createElement('li');
        li.className = 'task';
        li.dataset.taskId = taskData.id;
        li.dataset.originalCategory = taskData.originalCategory; // Store original category

        li.innerHTML = `
            <div class="task-header">
                <span class="task-name">${taskData.name}</span>
                <select class="priority-selector">
                    <option value="important">Quan trọng</option>
                    <option value="normal">Bình thường</option>
                    <option value="low">Không quan trọng</option>
                </select>
                <div class="task-controls">
                    <button class="toggle-notes">Xem Chi Tiết / Ghi Chú</button>
                    <select class="status-selector">
                        <option value="incomplete">Chưa Hoàn Thành</option>
                        <option value="in-progress">Đang Làm</option>
                        <option value="completed">Đã Hoàn Thành</option>
                    </select>
                </div>
            </div>
            <div class="task-time-info">
                <div class="time-inputs">
                    <label>Deadline: <input type="datetime-local" class="task-time-input deadline-input"></label>
                </div>
                <div class="countdown"></div>
            </div>
            <div class="task-notes" style="display: none;">
                <textarea placeholder="Ghi chú về việc này..."></textarea>
                <div class="display-notes" style="display: block;"></div> <!-- New div to display notes with clickable links -->
                <button class="save-notes">Lưu Ghi Chú</button>
            </div>
        `;

        // Set initial values for selectors and inputs
        const statusSelector = li.querySelector('.status-selector');
        if (statusSelector) statusSelector.value = taskData.status;

        const prioritySelector = li.querySelector('.priority-selector');
        if (prioritySelector) {
            prioritySelector.value = taskData.priority;
            updatePriorityClass(li, taskData.priority);
        }

        const notesTextarea = li.querySelector('.task-notes textarea');
        const displayNotesDiv = li.querySelector('.display-notes'); // Get the new display div

        if (notesTextarea) {
            notesTextarea.value = taskData.notes || '';
            // Initially display notes with links. When notes section is hidden, displayNotesDiv is shown.
            displayNotesDiv.innerHTML = convertUrlsToLinks(taskData.notes || '');
        }

        const deadlineInput = li.querySelector('.deadline-input');
        if (deadlineInput && taskData.deadline) {
            deadlineInput.value = taskData.deadline;
        }

        // Apply initial CSS classes based on status and attach event listeners
        updateTaskStatusClass(li, taskData.status);
        attachTaskEventListeners(li);
        return li;
    }

    // --- Firestore Data Management ---

    /**
     * Sets up a real-time listener for user-specific tasks in Firestore.
     * Clears existing tasks and re-renders based on Firestore updates.
     */
    function setupFirestoreListeners() {
        if (!db || !currentUserUid || !appGlobalId) {
            console.error("Firestore, User UID, or App ID not available for listeners.");
            return;
        }

        // Reference to the user's tasks collection
        const tasksCollectionRef = collection(db, 'artifacts', appGlobalId, 'users', currentUserUid, 'tasks');
        const q = query(tasksCollectionRef); // Get all tasks for this user

        onSnapshot(q, (snapshot) => {
            // Clear current tasks in DOM to re-render based on snapshot
            for (const key in taskLists) {
                if (taskLists.hasOwnProperty(key)) {
                    taskLists[key].innerHTML = '';
                }
            }

            // Clear the cache before populating with new data from snapshot
            tasksCache = {}; 
            const allTasksData = [];

            snapshot.forEach(doc => {
                const taskData = doc.data();
                // Ensure the task has an ID that matches the document ID
                taskData.id = doc.id; 
                tasksCache[doc.id] = taskData; // Populate the cache
                allTasksData.push(taskData);
            });

            // Group tasks by original category and then by status for rendering
            const tasksByCategory = {
                marketing: [],
                gamedev: [],
                personal: [],
                archive: []
            };

            allTasksData.forEach(taskData => {
                if (taskData.status === 'completed') {
                    tasksByCategory.archive.push(taskData);
                } else {
                    const categoryList = tasksByCategory[taskData.originalCategory];
                    if (categoryList) {
                        categoryList.push(taskData);
                    }
                }
            });

            // Sort and append tasks for each active category (non-archive)
            for (const categoryId in taskLists) {
                if (categoryId !== 'archive') {
                    const tasksInThisCategory = tasksByCategory[categoryId];
                    tasksInThisCategory.sort(sortTasks); // Sort tasks based on priority and deadline
                    tasksInThisCategory.forEach(taskData => {
                        const taskElement = createTaskElement(taskData);
                        taskLists[categoryId].appendChild(taskElement);
                    });
                }
            }

            // Append tasks to archive (no specific sorting here for now)
            tasksByCategory.archive.forEach(taskData => {
                const taskElement = createTaskElement(taskData);
                taskLists.archive.appendChild(taskElement);
            });
            console.log("Tasks loaded/updated from Firestore.");
        }, (error) => {
            console.error("Error listening to Firestore tasks:", error);
            showMessage("Lỗi tải công việc từ đám mây. Vui lòng kiểm tra kết nối.", "error");
        });
    }

    /**
     * Retrieves a task's data from the local tasksCache by its ID.
     * @param {string} taskId - The ID of the task to retrieve.
     * @returns {object|null} The task object from cache or null if not found.
     */
    function getTaskData(taskId) {
        return tasksCache[taskId] || null;
    }


    /**
     * Saves or updates a task's data in Firestore.
     * @param {object} taskData - The task object to save/update. Must have an 'id' for existing tasks.
     */
    async function saveTaskData(taskData) {
        if (!db || !currentUserUid || !appGlobalId) {
            console.error("Firestore, User UID, or App ID not available for saving.");
            showMessage("Lỗi: Không thể lưu dữ liệu. Đảm bảo bạn đã đăng nhập.", "error");
            return;
        }
        try {
            const docRef = doc(db, 'artifacts', appGlobalId, 'users', currentUserUid, 'tasks', taskData.id);
            await setDoc(docRef, taskData); // setDoc merges if doc exists, creates if not
            console.log("Task saved successfully:", taskData.id);
        } catch (e) {
            console.error("Error saving document:", e);
            showMessage("Lỗi khi lưu công việc. Vui lòng thử lại.", "error");
        }
    }

    /**
     * Adds a new task to Firestore. Firestore will generate the document ID.
     * @param {object} newTaskData - The new task object without an ID.
     */
    async function addNewTaskToFirestore(newTaskData) {
        if (!db || !currentUserUid || !appGlobalId) {
            console.error("Firestore, User UID, or App ID not available for adding new task.");
            showMessage("Lỗi: Không thể thêm công việc. Đảm bảo bạn đã đăng nhập.", "error");
            return;
        }
        try {
            const tasksCollectionRef = collection(db, 'artifacts', appGlobalId, 'users', currentUserUid, 'tasks');
            const docRef = await addDoc(tasksCollectionRef, newTaskData);
            console.log("New task added with ID:", docRef.id);
            // The onSnapshot listener will automatically re-render the UI
        } catch (e) {
            console.error("Error adding document:", e);
            showMessage("Lỗi khi thêm công việc mới. Vui lòng thử lại.", "error");
        }
    }


    // --- Sorting Logic ---
    /**
     * Comparison function for sorting tasks based on priority and deadline.
     * @param {object} taskA - The first task object.
     * @param {object} taskB - The second task object.
     * @returns {number} A negative number if taskA should come before taskB,
     * a positive number if taskB should come before taskA,
     * or 0 if their order doesn't matter.
     */
    function sortTasks(taskA, taskB) {
        // Sort by priority first: Important (1), Normal (2), Low (3)
        const priorityA = PRIORITY_ORDER[taskA.priority] || 99; // Default to low priority if not set
        const priorityB = PRIORITY_ORDER[taskB.priority] || 99;

        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }

        // If priorities are the same, sort by deadline (earliest first)
        const deadlineA = taskA.deadline ? new Date(taskA.deadline).getTime() : Infinity; // Infinity for tasks without deadline
        const deadlineB = taskB.deadline ? new Date(taskB.deadline).getTime() : Infinity;

        return deadlineA - deadlineB;
    }

    // --- UI Updates ---
    /**
     * Updates the CSS class of a task element based on its status.
     * @param {HTMLLIElement} taskElement - The task list item element.
     * @param {string} status - The new status ('incomplete', 'in-progress', 'completed').
     */
    function updateTaskStatusClass(taskElement, status) {
        taskElement.classList.remove('incomplete', 'in-progress', 'completed');
        taskElement.classList.add(status);
    }

    /**
     * Updates the CSS class of a task element's priority selector based on its priority.
     * @param {HTMLLIElement} taskElement - The task list item element.
     * @param {string} priority - The new priority ('important', 'normal', 'low').
     */
    function updatePriorityClass(taskElement, priority) {
        const prioritySelector = taskElement.querySelector('.priority-selector');
        if (prioritySelector) {
            prioritySelector.classList.remove('priority-important', 'priority-normal', 'priority-low');
            prioritySelector.classList.add(`priority-${priority}`);
        }
    }

    /**
     * Updates the countdown display and its color based on the remaining time relative to total task duration.
     * @param {HTMLLIElement} taskElement - The task list item element.
     * @param {string} deadlineString - The deadline string (ISO 8601 format).
     */
    function updateCountdown(taskElement, deadlineString) {
        const countdownSpan = taskElement.querySelector('.countdown');
        if (!countdownSpan) return;

        // Clear all previous color and status classes
        countdownSpan.classList.remove('color-green', 'color-yellow', 'color-red', 'finished', 'invalid-times');

        const deadline = new Date(deadlineString).getTime();
        const now = new Date().getTime();
        
        // Retrieve the saved start time from task data for total duration calculation
        const taskData = getTaskData(taskElement.dataset.taskId); // Get from local cache (DOM's data-set)
        // If start time is not set, default it to the current time for calculation
        const startTime = taskData && taskData.startTime ? new Date(taskData.startTime).getTime() : now; 

        // Handle cases where deadline is not set or invalid
        if (!deadlineString) {
            countdownSpan.textContent = 'Chưa đặt thời gian';
            return;
        }

        // Check for invalid time range (start after or at deadline)
        if (startTime >= deadline) {
            countdownSpan.textContent = 'Thời gian không hợp lệ!';
            countdownSpan.classList.add('invalid-times');
            return;
        }
        
        const totalDuration = deadline - startTime; // Total available time for the task
        const remainingTime = deadline - now;     // Time left until deadline

        if (remainingTime < 0) {
            // Task is overdue
            countdownSpan.textContent = 'Đã hết hạn!';
            countdownSpan.classList.add('finished');
        } else if (now < startTime) {
            // Task has not started yet
            const timeLeftToStart = startTime - now;
            const days = Math.floor(timeLeftToStart / (1000 * 60 * 60 * 24));
            const hours = Math.floor((timeLeftToStart % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((timeLeftToStart % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((timeLeftToStart % (1000 * 60)) / 1000);
            countdownSpan.textContent = `Bắt đầu sau: ${days} ngày ${hours} giờ ${minutes} phút ${seconds} giây`;
            countdownSpan.classList.add('color-green'); // Still green before actual work starts
        }
        else {
            // Task is in progress and time is remaining
            const days = Math.floor(remainingTime / (1000 * 60 * 60 * 24));
            const hours = Math.floor((remainingTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);

            countdownSpan.textContent = `Còn lại: ${days} ngày ${hours} giờ ${minutes} phút ${seconds} giây`;

            // Color logic based on percentage of total duration remaining
            const percentageRemaining = totalDuration > 0 ? (remainingTime / totalDuration) : 0;

            if (percentageRemaining > 0.7) { // More than 70% time remaining
                countdownSpan.classList.add('color-green');
            } else if (percentageRemaining > 0.4) { // Between 40% and 70% time remaining
                countdownSpan.classList.add('color-yellow');
            } else { // 40% or less time remaining
                countdownSpan.classList.add('color-red');
            }
        }
    }


    // --- Event Listeners Attachment ---
    /**
     * Attaches all necessary event listeners to a task element.
     * @param {HTMLLIElement} taskElement - The task list item element to attach listeners to.
     */
    function attachTaskEventListeners(taskElement) {
        const taskId = taskElement.dataset.taskId;
        const toggleNotesButton = taskElement.querySelector('.toggle-notes');
        const taskNotesDiv = taskElement.querySelector('.task-notes');
        const notesTextarea = taskElement.querySelector('.task-notes textarea');
        const displayNotesDiv = taskElement.querySelector('.display-notes'); // Get the new display div
        const saveNotesButton = taskElement.querySelector('.save-notes');
        const statusSelector = taskElement.querySelector('.status-selector');
        const prioritySelector = taskElement.querySelector('.priority-selector');
        const deadlineInput = taskElement.querySelector('.deadline-input');

        // Toggle notes visibility
        if (toggleNotesButton) {
            toggleNotesButton.addEventListener('click', () => {
                if (taskNotesDiv) {
                    const isCurrentlyEditing = notesTextarea.style.display === 'block';

                    if (isCurrentlyEditing) {
                        // User is switching from editing to viewing
                        notesTextarea.style.display = 'none'; // Hide textarea
                        displayNotesDiv.style.display = 'block'; // Show display div
                        displayNotesDiv.innerHTML = convertUrlsToLinks(notesTextarea.value); // Update display with current textarea value
                        toggleNotesButton.textContent = 'Xem Chi Tiết / Ghi Chú'; // Reset button text
                        // No need to save here, saveNotesButton handles that explicitly
                    } else {
                        // User is switching from viewing to editing
                        notesTextarea.style.display = 'block'; // Show textarea
                        displayNotesDiv.style.display = 'none'; // Hide display div
                        notesTextarea.value = (getTaskData(taskId) || {}).notes || ''; // Load saved notes into textarea
                        toggleNotesButton.textContent = 'Ẩn Chi Tiết / Ghi Chú';
                    }
                }
            });
        }

        // Save notes
        if (saveNotesButton) {
            saveNotesButton.addEventListener('click', async () => {
                const taskData = getTaskData(taskId);
                const currentNotes = notesTextarea ? notesTextarea.value : '';
                taskData.notes = currentNotes;
                await saveTaskData(taskData); // Use await here
                
                // Update the display div with clickable links after saving
                if (displayNotesDiv) {
                    displayNotesDiv.innerHTML = convertUrlsToLinks(currentNotes);
                    notesTextarea.style.display = 'none'; // Hide textarea
                    displayNotesDiv.style.display = 'block'; // Show display div
                    toggleNotesButton.textContent = 'Xem Chi Tiết / Ghi Chú'; // Reset button text
                }
                showMessage('Ghi chú đã được lưu!');
            });
        }

        // Update status and move task between lists
        if (statusSelector) {
            statusSelector.addEventListener('change', async () => {
                const newStatus = statusSelector.value;
                const taskData = getTaskData(taskId);
                taskData.status = newStatus;
                await saveTaskData(taskData); // Use await here
                // UI will be re-rendered by onSnapshot listener automatically
                // No need to manually move elements here.
            });
        }

        // Update priority and re-sort tasks within its category
        if (prioritySelector) {
            prioritySelector.addEventListener('change', async () => {
                const newPriority = prioritySelector.value;
                const taskData = getTaskData(taskId);
                taskData.priority = newPriority;
                await saveTaskData(taskData); // Use await here
                updatePriorityClass(taskElement, newPriority);
                // UI will be re-rendered by onSnapshot listener, which handles sorting.
            });
        }

        // Update deadline and re-sort tasks within its category
        if (deadlineInput) {
            deadlineInput.addEventListener('change', async () => {
                const newDeadline = deadlineInput.value;
                const taskData = getTaskData(taskId);
                taskData.deadline = newDeadline;
                // Set startTime to current time if it's not already set.
                // This defines the start of the "total duration" for color logic.
                if (!taskData.startTime) {
                    taskData.startTime = new Date().toISOString().slice(0, 16); 
                }
                await saveTaskData(taskData); // Use await here
                updateCountdown(taskElement, taskData.deadline); // Update immediately
                // UI will be re-rendered by onSnapshot listener, which handles sorting.
            });
        }
    }

    // --- Add Task Form Functionality ---
    /**
     * Attaches event listeners to the "Add Task" buttons to toggle the visibility of the add task form.
     */
    addTaskButtons.forEach(button => {
        button.addEventListener('click', () => {
            const categoryId = button.dataset.categoryId;
            const addTaskForm = document.querySelector(`.add-task-form[data-category-id="${categoryId}"]`);
            if (addTaskForm) {
                addTaskForm.style.display = addTaskForm.style.display === 'flex' ? 'none' : 'flex';
                // Clear inputs when showing form
                if (addTaskForm.style.display === 'flex') {
                    addTaskForm.querySelector('.new-task-name').value = '';
                    addTaskForm.querySelector('.new-task-deadline').value = '';
                    addTaskForm.querySelector('.new-task-priority').value = 'normal';
                }
            }
        });
    });

    /**
     * Attaches event listeners to the "Create Task" buttons within add task forms.
     * Handles creating new tasks, saving them to Firestore, and re-rendering the category.
     */
    categories.forEach(categoryElement => {
        const createButton = categoryElement.querySelector('.create-task-btn');
        if (createButton) {
            createButton.addEventListener('click', async () => {
                const categoryId = categoryElement.dataset.category;
                const taskNameInput = categoryElement.querySelector('.new-task-name');
                const deadlineInput = categoryElement.querySelector('.new-task-deadline');
                const prioritySelector = categoryElement.querySelector('.new-task-priority');

                const taskName = taskNameInput.value.trim();
                const deadline = deadlineInput.value;
                const priority = prioritySelector ? prioritySelector.value : 'normal'; // Default to normal if not selected

                if (!taskName) {
                    showMessage('Tên công việc không được để trống!', 'error');
                    return;
                }
                if (!currentUserUid) {
                    showMessage("Lỗi: Vui lòng đợi đăng nhập hoàn tất để thêm công việc.", "error");
                    return;
                }

                const newTaskData = {
                    name: taskName,
                    status: 'incomplete', // New tasks are incomplete by default
                    notes: '',
                    startTime: new Date().toISOString().slice(0, 16), // Set start time to current creation time
                    deadline: deadline,
                    priority: priority,
                    originalCategory: categoryId, // Store original category
                    userId: currentUserUid // Store the user ID for security rules and querying
                };

                await addNewTaskToFirestore(newTaskData); // Add new task to Firestore, onSnapshot will handle UI update
                
                // Clear form inputs and hide the form
                taskNameInput.value = '';
                deadlineInput.value = '';
                if (prioritySelector) prioritySelector.value = 'normal'; // Reset priority to default
                categoryElement.querySelector('.add-task-form').style.display = 'none';
                showMessage('Đã thêm công việc mới!');
            });
        }
    });

    // --- Initialize Application ---
    // Countdown interval needs to be global, but only updates tasks that are already rendered.
    // The main data loading is handled by onSnapshot which is triggered after auth.
    setInterval(() => {
        document.querySelectorAll('.task').forEach(taskElement => {
            const taskId = taskElement.dataset.taskId;
            const taskData = getTaskData(taskId); // Get from local cache (DOM's data-set)
            // Only update countdown for tasks that are not completed
            if (taskData && taskData.status !== 'completed') {
                updateCountdown(taskElement, taskData.deadline);
            }
        });
    }, 1000); // Update every 1 second
});
