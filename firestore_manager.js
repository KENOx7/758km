import {
    collection,
    addDoc,
    getDocs,
    getDoc,
    doc,
    updateDoc,
    deleteDoc,
    setDoc,
    query,
    where,
    serverTimestamp,
    orderBy,
    limit,
    runTransaction
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

export class SystemManager {
    constructor(db) {
        this.db = db;
    }

    // --- Semester Management ---

    async createSemester(name) {
        const semesterRef = doc(collection(this.db, "semesters"));
        const semesterId = semesterRef.id;

        await setDoc(semesterRef, {
            name: name,
            status: "active",
            createdAt: serverTimestamp()
        });

        // Archive old active semester if exists
        const configRef = doc(this.db, "metadata", "config");
        const configSnap = await getDoc(configRef);

        if (configSnap.exists()) {
            const oldActiveId = configSnap.data().activeSemesterId;
            if (oldActiveId) {
                try {
                    await updateDoc(doc(this.db, "semesters", oldActiveId), {
                        status: "archived"
                    });
                } catch (e) { console.warn("Could not archive old semester (maybe didn't exist):", e); }
            }
        }

        await setDoc(configRef, { activeSemesterId: semesterId }, { merge: true });

        // Initialize default group
        await this.initializeGroupForSemester(semesterId, "758_ITS", "758/ITS", 2);

        return semesterId;
    }

    async getActiveSemester() {
        // Try config first
        const configRef = doc(this.db, "metadata", "config");
        const configSnap = await getDoc(configRef);

        if (configSnap.exists() && configSnap.data().activeSemesterId) {
            const sid = configSnap.data().activeSemesterId;
            const sSnap = await getDoc(doc(this.db, "semesters", sid));
            if (sSnap.exists()) return { id: sSnap.id, ...sSnap.data() };
        }

        // Fallback or initial state
        const q = query(collection(this.db, "semesters"), where("status", "==", "active"), limit(1));
        const snap = await getDocs(q);
        if (snap.empty) return null;
        const docSnap = snap.docs[0];
        return { id: docSnap.id, ...docSnap.data() };
    }

    async getArchivedSemesters() {
        // Query for archived semesters
        // Note: Use simple query to avoid index requirements for now
        const q = query(collection(this.db, "semesters"), where("status", "==", "archived"));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    // --- Group & Subject Management ---

    async initializeGroupForSemester(semesterId, groupId, groupName, course) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);
        await setDoc(groupRef, {
            name: groupName,
            course: course,
            subjects: [],
            schedule: { alt: {}, ust: {} }
        });
    }

    async addSubjectToGroup(semesterId, groupId, subjectName, limit = 7) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);

        await runTransaction(this.db, async (transaction) => {
            const groupDoc = await transaction.get(groupRef);
            if (groupDoc.exists()) {
                const data = groupDoc.data();
                const currentSubjects = data.subjects || [];
                const limits = data.subjectLimits || {};

                if (!currentSubjects.includes(subjectName)) {
                    currentSubjects.push(subjectName);
                }

                // Update or set limit
                limits[subjectName] = parseInt(limit);

                transaction.update(groupRef, {
                    subjects: currentSubjects,
                    subjectLimits: limits
                });
            }
        });
    }

    async getGroupSubjects(semesterId, groupId) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);
        const snap = await getDoc(groupRef);
        if (snap.exists()) {
            const data = snap.data();
            return {
                subjects: data.subjects || [],
                limits: data.subjectLimits || {}
            };
        }
        return { subjects: [], limits: {} };
    }

    async updateSubject(semesterId, groupId, oldName, newName, limit) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);

        await runTransaction(this.db, async (transaction) => {
            const groupDoc = await transaction.get(groupRef);
            if (!groupDoc.exists()) throw "Group not found!";

            const data = groupDoc.data();
            let subjects = data.subjects || [];
            let limits = data.subjectLimits || {};

            // 1. Rename if needed
            if (oldName !== newName) {
                const idx = subjects.indexOf(oldName);
                if (idx !== -1) {
                    subjects[idx] = newName;
                    // Move limit
                    if (limits[oldName]) {
                        limits[newName] = limits[oldName];
                        delete limits[oldName];
                    }
                }
            }

            // 2. Update limit
            limits[newName] = parseInt(limit);

            transaction.update(groupRef, {
                subjects: subjects,
                subjectLimits: limits
            });
        });
    }

    async deleteSubject(semesterId, groupId, subjectName) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);

        await runTransaction(this.db, async (transaction) => {
            const groupDoc = await transaction.get(groupRef);
            if (!groupDoc.exists()) throw "Group not found!";

            const data = groupDoc.data();
            let subjects = data.subjects || [];
            let limits = data.subjectLimits || {};

            const idx = subjects.indexOf(subjectName);
            if (idx !== -1) {
                subjects.splice(idx, 1);
            }

            if (limits[subjectName]) {
                delete limits[subjectName];
            }

            transaction.update(groupRef, {
                subjects: subjects,
                subjectLimits: limits
            });
        });
    }

    // --- Schedule Management ---

    async addLessonToSchedule(semesterId, groupId, weekType, dayIndex, lessonString) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);

        await runTransaction(this.db, async (transaction) => {
            const groupDoc = await transaction.get(groupRef);
            if (!groupDoc.exists()) throw "Group not found!";

            const data = groupDoc.data();
            const schedule = data.schedule || { alt: {}, ust: {} };

            if (!schedule[weekType]) schedule[weekType] = {};
            if (!schedule[weekType][dayIndex]) schedule[weekType][dayIndex] = [];

            schedule[weekType][dayIndex].push(lessonString);
            transaction.update(groupRef, { schedule: schedule });
        });
    }

    async deleteLessonFromSchedule(semesterId, groupId, weekType, dayIndex, lessonString) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);

        await runTransaction(this.db, async (transaction) => {
            const groupDoc = await transaction.get(groupRef);
            if (!groupDoc.exists()) throw "Group not found!";

            const data = groupDoc.data();
            const schedule = data.schedule || { alt: {}, ust: {} };

            if (schedule[weekType] && schedule[weekType][dayIndex]) {
                const arr = schedule[weekType][dayIndex];
                const index = arr.indexOf(lessonString);
                if (index > -1) {
                    arr.splice(index, 1);
                    transaction.update(groupRef, { schedule: schedule });
                }
            }
        });
    }

    async updateLessonInSchedule(semesterId, groupId, weekType, dayIndex, oldLessonString, newLessonString) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);

        await runTransaction(this.db, async (transaction) => {
            const groupDoc = await transaction.get(groupRef);
            if (!groupDoc.exists()) throw "Group not found!";

            const data = groupDoc.data();
            const schedule = data.schedule || { alt: {}, ust: {} };

            if (schedule[weekType] && schedule[weekType][dayIndex]) {
                const arr = schedule[weekType][dayIndex];
                const index = arr.indexOf(oldLessonString);
                if (index > -1) {
                    // Replace
                    arr[index] = newLessonString;
                    transaction.update(groupRef, { schedule: schedule });
                } else {
                    throw "Lesson not found to update";
                }
            } else {
                throw "Lesson path not found";
            }
        });
    }

    async getGroupSchedule(semesterId, groupId) {
        const groupRef = doc(this.db, "semesters", semesterId, "groups", groupId);
        const snap = await getDoc(groupRef);
        if (snap.exists()) return snap.data().schedule;
        return null;
    }

    // --- Student & Absence Management ---

    async ensureStudentExists(fullName, groupId) {
        // Check if student exists in 'students' collection (global)
        // We use name as ID for simplicity or generate ID? 
        // Let's query by name to avoid dupes, if not found create.

        const q = query(collection(this.db, "students"), where("fullName", "==", fullName), where("groupId", "==", groupId));
        const snap = await getDocs(q);

        if (!snap.empty) {
            return snap.docs[0].id;
        }

        // Create new
        const ref = await addDoc(collection(this.db, "students"), {
            fullName: fullName,
            groupId: groupId,
            createdAt: serverTimestamp()
        });
        return ref.id;
    }

    async addAbsence(semesterId, studentName, subject, date) {
        const studentId = await this.ensureStudentExists(studentName, "758_ITS");

        // Add to subcollection
        const absencesRef = collection(this.db, "students", studentId, "semesters", semesterId, "absences");
        await addDoc(absencesRef, {
            subject: subject,
            date: date,
            timestamp: serverTimestamp()
        });

        // Add to global log for admin view
        await addDoc(collection(this.db, "absences_log"), {
            studentId,
            studentName,
            semesterId,
            subject,
            date,
            timestamp: serverTimestamp()
        });
    }

    async deleteAbsenceLog(logId) {
        await deleteDoc(doc(this.db, "absences_log", logId));
    }

    // --- Migration Tools ---

    async migrateStudents(studentList, groupId) {
        let count = 0;
        for (const name of studentList) {
            await this.ensureStudentExists(name, groupId);
            count++;
        }
        console.log(`Migrated ${count} students.`);
        return count;
    }

    async migrateOldAbsences() {
        const oldRef = collection(this.db, "qayiblar");
        const snap = await getDocs(oldRef);
        let count = 0;

        for (const oldDoc of snap.docs) {
            const data = oldDoc.data();

            if (!data.usaqAdi) continue;

            const studentId = await this.ensureStudentExists(data.usaqAdi, "758_ITS");

            await addDoc(collection(this.db, "absences_log"), {
                studentId: studentId,
                studentName: data.usaqAdi,
                semesterId: "legacy_archive",
                subject: data.fenn || "Unknown",
                date: data.tarix || "Unknown",
                timestamp: data.timestamp || serverTimestamp(),
                migrated: true
            });
            count++;
        }
        return count;
    }

    // --- Legacy Data Access ---

    async getLegacyAbsences() {
        const q = query(collection(this.db, "qayiblar"), orderBy("tarix", "desc"));
        const snap = await getDocs(q);
        return snap.docs.map(d => {
            const data = d.data();
            return {
                id: d.id,
                studentName: data.usaqAdi, // Map legacy field to new format
                subject: data.fenn,        // Map legacy field
                date: data.tarix,          // Map legacy field
                timestamp: data.timestamp,
                isLegacy: true
            };
        });
    }

    async getAllStudents(groupId) {
        const q = query(collection(this.db, "students"), where("groupId", "==", groupId));
        const snap = await getDocs(q);
        return snap.docs.map(d => d.data().fullName).sort();
    }

    // --- Grades Management ---

    async addGrade(semesterId, groupId, studentName, subject, gradeValue) {
        const studentId = await this.ensureStudentExists(studentName, groupId);

        await addDoc(collection(this.db, "grades_log"), {
            studentId,
            studentName,
            semesterId,
            groupId,
            subject,
            grade: Number(gradeValue),
            timestamp: serverTimestamp()
        });
    }

    async deleteGrade(logId) {
        await deleteDoc(doc(this.db, "grades_log", logId));
    }
}