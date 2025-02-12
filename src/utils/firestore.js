Untitled

import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDocs,
    query,
    updateDoc,
    orderBy,
    arrayUnion,
    setDoc,
    where,
    writeBatch,
    getCountFromServer,
    limit,
} from 'firebase/firestore';
import { db } from './firebase';
import { Type } from '../components/Notifier';

// Data validation utilities
const validateSessionData = (sessionData) => {
    const requiredFields = [
        'dateTime',
        'recorder',
        'handler',
        'site',
        'array',
        'noCaptures',
        'trapStatus',
        'year'
    ];
    return requiredFields.every(field => sessionData[field] && sessionData[field] !== '');
};

const validateEntryData = (entryData) => {
    const requiredFields = [
        'dateTime',
        'site',
        'array',
        'taxa',
        'sessionDateTime'
    ];
    return requiredFields.every(field => entryData[field] && entryData[field] !== '');
};

// Helper functions
const getStandardizedDateTimeString = (dateString) => {
    const tempDate = new Date(dateString);
    return `${tempDate.getFullYear()}/${String(tempDate.getMonth() + 1).padStart(2, '0')}/${String(tempDate.getDate()).padStart(2, '0')} ${tempDate.toLocaleTimeString('en-US', { hourCycle: 'h23' })}`;
};

const getCollectionName = (environment, projectName, tableName) => {
    return `${environment === 'test' ? 'Test' : ''}${projectName}${tableName === 'Session' ? 'Session' : 'Data'}`;
};

const getCollectionNameFromDoc = (snapshot) => snapshot?.ref.parent.id;

const handleFirestoreError = (error) => {
    const errorMap = {
        'permission-denied': 'You do not have permission to perform this operation.',
        'not-found': 'The requested document was not found.',
        'already-exists': 'A document with this ID already exists.',
        'failed-precondition': 'Operation failed due to document state.',
        'invalid-argument': 'Invalid data provided for operation.',
        'deadline-exceeded': 'Operation timed out.',
    };

    const errorMessage = errorMap[error.code] || error.message || 'An unknown error occurred';
    console.error('Firestore operation failed:', {
        code: error.code,
        message: error.message,
        details: error
    });

    return [Type.error, errorMessage];
};

// Metadata operations
const updateLizardMetadata = async (operation, operationDataObject) => {
    const lizardDoc = doc(db, 'Metadata', 'LizardData');
    const { entrySnapshot } = operationDataObject;
    try {
        if (operation === 'update') {
            await updateDoc(lizardDoc, { lastEditTime: operationDataObject.lastEditTime });
        } else if (operation === 'delete') {
            await updateDoc(lizardDoc, {
                deletedEntries: arrayUnion({
                    entryId: entrySnapshot.id,
                    collectionId: entrySnapshot.ref.parent.id,
                }),
            });
        }
        console.log(`Sent ${operation} to the PWA`);
    } catch (e) {
        console.error(`Error sending ${operation} to PWA: ${e}`);
    }
};

// Core document operations
const deleteDocumentFromFirestore = async (entrySnapshot, deleteMsg) => {
    let response = [];
    try {
        await deleteDoc(doc(db, entrySnapshot.ref.parent.id, entrySnapshot.id));
        response = [Type.success, deleteMsg || 'Document successfully deleted!'];
    } catch (e) {
        response = [Type.error, `Error deleting document: ${e}`];
    }
    if (entrySnapshot.data().taxa === 'Lizard') {
        updateLizardMetadata('delete', { entrySnapshot });
    }
    return response;
};

const pushEntryChangesToFirestore = async (entrySnapshot, entryData, editMsg) => {
    if (entryData.taxa === 'Lizard') {
        const lastEditTime = new Date().getTime();
        entryData.lastEdit = lastEditTime;
        updateLizardMetadata('update', { lastEditTime });
    }
    let response = [];
    if (entryData.dateTime) {
        const newDate = new Date(entryData.dateTime);
        if (!isNaN(newDate)) {
            entryData.year = newDate.getFullYear();
        }
    }
    await setDoc(doc(db, entrySnapshot.ref.parent.id, entrySnapshot.id), entryData)
        .then(() => {
            response = [Type.success, editMsg || 'Changes successfully written to database!'];
        })
        .catch((e) => {
            response = [Type.error, `Error writing changes to database: ${e}`];
        });
    return response;
};

// Collection operations
const getDocsFromCollection = async (collectionName, constraints = []) => {
    if (!Array.isArray(constraints)) constraints = [constraints];
    try {
        const currentQuery = query(
            collection(db, collectionName),
            orderBy('dateTime', 'desc'),
            ...constraints,
        );
        return await getDocs(currentQuery);
    } catch (error) {
        console.error('Error loading entries:', error);
        return null;
    }
};

const addDocToCollection = async (collectionName, data) => {
    try {
        const docRef = await addDoc(collection(db, collectionName), data);
        console.log(`Document written to collection: ${collectionName} with ID: ${docRef.id}`);
        return docRef;
    } catch (error) {
        console.error('Error adding document:', error);
        return null;
    }
};

const updateDocInCollection = async (collectionName, docId, data) => {
    try {
        await updateDoc(doc(db, collectionName, docId), data);
        console.log('Document successfully updated!');
        return true;
    } catch (error) {
        console.error('Error updating document:', error);
        return false;
    }
};

const deleteDocFromCollection = async (collectionName, docId) => {
    try {
        await deleteDoc(doc(db, collectionName, docId));
        console.log('Document successfully deleted!');
        return true;
    } catch (error) {
        console.error('Error removing document:', error);
        return false;
    }
};

// Batch operations
const batchUpdateEntries = async (entries, updateData) => {
    const batch = writeBatch(db);
    try {
        entries.forEach(entry => {
            const docRef = doc(db, entry.ref.parent.id, entry.id);
            batch.update(docRef, updateData);
        });
        await batch.commit();
        return [Type.success, 'Batch update successful'];
    } catch (error) {
        console.error('Batch update failed:', error);
        return [Type.error, 'Batch update failed'];
    }
};

const batchDeleteEntries = async (entries) => {
    const batch = writeBatch(db);
    try {
        entries.forEach(entry => {
            const docRef = doc(db, entry.ref.parent.id, entry.id);
            batch.delete(docRef);
        });
        await batch.commit();
        return [Type.success, 'Batch delete successful'];
    } catch (error) {
        console.error('Batch delete failed:', error);
        return [Type.error, 'Batch delete failed'];
    }
};

// Session operations
const editSessionAndItsEntries = async (sessionSnapshot, sessionData) => {
    const collectionId = sessionSnapshot.ref.parent.id.slice(0, -7);
    const entriesQuery = query(
        collection(db, `${collectionId}Data`),
        sessionSnapshot.data().sessionId
            ? where('sessionId', '==', sessionSnapshot.data().sessionId)
            : where('sessionDateTime', '==', sessionSnapshot.data().dateTime),
    );
    const entries = await getDocs(entriesQuery);
    const batch = writeBatch(db);
    entries.docs.forEach((entry) => {
        batch.update(doc(db, entry.ref.parent.id, entry.id), {
            dateTime: sessionData.dateTime,
            sessionDateTime: sessionData.dateTime,
        });
    });
    await batch.commit();
    return pushEntryChangesToFirestore(
        sessionSnapshot,
        sessionData,
        `Session ${entries.size ? `and its ${entries.size} entries` : ''} successfully changed`,
    );
};

const deleteSessionAndItsEntries = async (sessionSnapshot) => {
    const collectionId = sessionSnapshot.ref.parent.id.slice(0, -7);
    const entries = await getDocs(
        query(
            collection(db, `${collectionId}Data`),
            where('sessionDateTime', '==', sessionSnapshot.data().dateTime),
        ),
    );
    const deletePromises = entries.docs.map((entry) => deleteDocumentFromFirestore(entry));
    await Promise.all(deletePromises);
    return deleteDocumentFromFirestore(
        sessionSnapshot,
        `Session ${entries.size ? `and its ${entries.size} entries` : ''} successfully deleted`,
    );
};

const getSessionsByProjectAndYear = async (environment, projectName, year) => {
    const collectionName = `${environment === 'test' ? 'Test' : ''}${projectName}Session`;
    const sessionsQuery = query(
        collection(db, collectionName),
        where('dateTime', '>=', `${year}/01/01 00:00:00`),
        where('dateTime', '<=', `${year}/12/31 23:59:59`),
        orderBy('dateTime', 'desc'),
    );
    return (await getDocs(sessionsQuery)).docs;
};

const getSessionEntryCount = async (sessionSnapshot) => {
    const collectionId = sessionSnapshot.ref.parent.id.slice(0, -7);
    const snapshot = await getCountFromServer(
        query(
            collection(db, `${collectionId}Data`),
            where('sessionDateTime', '==', sessionSnapshot.data().dateTime),
        ),
    );
    return snapshot.data().count;
};

const mergeSessionsData = async (sourceSession, targetSession) => {
    try {
        // Get all entries from source session
        const sourceEntries = await getDocs(
            query(
                collection(db, `${sourceSession.ref.parent.id.slice(0, -7)}Data`),
                where('sessionDateTime', '==', sourceSession.data().dateTime)
            )
        );

        // Update all entries to point to target session
        await batchUpdateEntries(sourceEntries.docs, {
            sessionDateTime: targetSession.data().dateTime,
            sessionId: targetSession.data().sessionId || new Date(targetSession.data().dateTime).getTime()
        });

        // Merge session comments
        const mergedComments = `${targetSession.data().commentsAboutTheArray || ''}; ${sourceSession.data().commentsAboutTheArray || ''}`.trim();
        await updateDoc(doc(db, targetSession.ref.parent.id, targetSession.id), {
            commentsAboutTheArray: mergedComments
        });

        // Delete source session
        await deleteDoc(doc(db, sourceSession.ref.parent.id, sourceSession.id));

        return [Type.success, 'Sessions merged successfully'];
    } catch (error) {
        console.error('Session merge failed:', error);
        return [Type.error, 'Session merge failed'];
    }
};

const findDuplicateSessions = async (environment, projectName, year) => {
    const sessions = await getSessionsByProjectAndYear(environment, projectName, year);
    const duplicates = [];
    
    // Group sessions by date (ignoring time)
    const groupedSessions = sessions.reduce((acc, session) => {
        const date = session.data().dateTime.split(' ')[0];
        if (!acc[date]) acc[date] = [];
        acc[date].push(session);
        return acc;
    }, {});

    // Find groups with multiple sessions
    Object.values(groupedSessions).forEach(group => {
        if (group.length > 1) {
            duplicates.push(group);
        }
    });

    return duplicates;
};

// AnswerSet operations
const getAnswerSetOptions = async (setName) => {
    const answerSet = await getDocs(
        query(collection(db, 'AnswerSet'), where('set_name', '==', setName)),
    );
    return answerSet.docs.flatMap((doc) => doc.data().answers.map((answer) => answer.primary));
};

const getArthropodLabels = async () => {
    const snapshot = await getDocs(
        query(collection(db, 'AnswerSet'), where('set_name', '==', 'ArthropodSpecies')),
    );
    const answers = snapshot.docs[0]?.data().answers || [];
    return answers.map((ans) => ans.primary).sort((a, b) => a.localeCompare(b));
};

const getSpeciesCodesForProjectByTaxa = async (project, taxa) => {
    const answerSet = await getDocs(
        query(collection(db, 'AnswerSet'), where('set_name', '==', `${project}${taxa}Species`)),
    );
    return answerSet.docs.flatMap((doc) =>
        doc.data().answers.map((answer) => ({
            code: answer.primary,
            genus: answer.secondary.Genus,
            species: answer.secondary.Species,
        })),
    );
};

// Entry operations
const uploadNewEntry = async (entryData, project, environment) => {
    try {
        if (!validateEntryData(entryData)) {
            console.error('Invalid entry data');
            return false;
        }

        const now = new Date();
        entryData.entryId = entryData.entryId || now.getTime();
        entryData.lastEdit = now.getTime();

        if (entryData.taxa === 'Arthropod') {
            entryData = {
                ...entryData,
                aran: entryData.aran || '0',
                auch: entryData.auch || '0',
                blat: entryData.blat || '0',
                chil: entryData.chil || '0',
                cole: entryData.cole || '0',
                crus: entryData.crus || '0',
                derm: entryData.derm || '0',
                diel: entryData.diel || '0',
                dipt: entryData.dipt || '0',
                hete: entryData.hete || '0',
                hyma: entryData.hyma || '0',
                hymb: entryData.hymb || '0',
                lepi: entryData.lepi || '0',
                mant: entryData.mant || '0',
                orth: entryData.orth || '0',
                pseu: entryData.pseu || '0',
                scor: entryData.scor || '0',
                soli: entryData.soli || '0',
                thys: entryData.thys || '0',
                unki: entryData.unki || '0',
                micro: entryData.micro || '0',
                taxa: 'N/A',
            };
        }

        if (entryData.taxa === 'Lizard') {
            try {
                await updateDoc(doc(db, 'Metadata', 'LizardData'), { 
                    lastEditTime: now.getTime() 
                });
            } catch (error) {
                console.error('Error updating lizard metadata:', error);
            }
        }

        const cleanedData = {};
        for (const [key, value] of Object.entries(entryData)) {
            if (key === 'sessionId' && !value) {
                cleanedData[key] = entryData.sessionDateTime ? 
                    new Date(entryData.sessionDateTime).getTime() : 
                    now.getTime();
            } else {
                cleanedData[key] = value === undefined || value === '' ? 'N/A' : value;
            }
        }

        const entryId = `${cleanedData.site}${cleanedData.taxa === 'N/A' ? 'Arthropod' : cleanedData.taxa}${cleanedData.entryId}`;
        const collectionName = `${environment === 'live' ? '' : 'Test'}${project.replace(/\s/g, '')}Data`;

        const docRef = doc(db, collectionName, entryId);
        await setDoc(docRef, cleanedData);
        return true;
    } catch (error) {
        console.error('Error in uploadNewEntry:', error);
        return false;
    }
};

const uploadNewSession = async (sessionData, project, environment) => {
    if (!validateSessionData(sessionData)) {
        console.error('Invalid session data');
        return false;
    }

    const collectionName = `${environment === 'live' ? '' : 'Test'}${project.replace(/\s/g, '')}Session`;
    try {
        await addDoc(collection(db, collectionName), sessionData);
        return true;
    } catch (error) {
        console.error('Error uploading new session:', error);
        return false;
    }
};

// Operation controller
const startEntryOperation = async (operationName, operationData) => {
    operationData.setEntryUIState('viewing');
    if (operationName.includes('delete')) operationData.removeEntryFromUI();
    
    switch (operationName) {
        case 'uploadEntryEdits':
            return pushEntryChangesToFirestore(operationData.entrySnapshot, operationData.entryData);
        case 'deleteEntry':
            return deleteDocumentFromFirestore(operationData.entrySnapshot);
        case 'deleteSession':
            return deleteSessionAndItsEntries(operationData.entrySnapshot);
        case 'uploadSessionEdits':
            return editSessionAndItsEntries(operationData.entrySnapshot, operationData.entryData);
        default:
            return [Type.error, 'Unknown operation'];
    }
};

// Date range utilities
const getSessionDateRange = async (environment, projectName) => {
    const collectionName = `${environment === 'test' ? 'Test' : ''}${projectName}Session`;
    const oldestSession = await getDocs(
        query(
            collection(db, collectionName),
            orderBy('dateTime', 'asc'),
            limit(1)
        )
    );
    const newestSession = await getDocs(
        query(
            collection(db, collectionName),
            orderBy('dateTime', 'desc'),
            limit(1)
        )
    );

    return {
        oldest: oldestSession.docs[0]?.data().dateTime,
        newest: newestSession.docs[0]?.data().dateTime
    };
};

// Helper exports
export const getSitesForProject = (projectName) => getAnswerSetOptions(`${projectName}Sites`);
export const getArraysForSite = (projectName, siteName) => getAnswerSetOptions(`${projectName}${siteName}Array`);
export const getTrapStatuses = () => getAnswerSetOptions('trap statuses');
export const getFenceTraps = () => getAnswerSetOptions('Fence Traps');
export const getSexes = () => getAnswerSetOptions('Sexes');

// Main exports
export {
    // Core operations
    getArthropodLabels,
    getDocsFromCollection,
    addDocToCollection,
    updateDocInCollection,
    deleteDocFromCollection,
    getCollectionName,
    getCollectionNameFromDoc,
    
    // Session operations
    startEntryOperation,
    getSessionsByProjectAndYear,
    getSessionEntryCount,
    editSessionAndItsEntries,
    deleteSessionAndItsEntries,
    mergeSessionsData,
    findDuplicateSessions,
    getSessionDateRange,
    
    // Entry operations
    uploadNewEntry,
    uploadNewSession,
    pushEntryChangesToFirestore,
    deleteDocumentFromFirestore,
    
    // Batch operations
    batchUpdateEntries,
    batchDeleteEntries,
    
    // Metadata operations
    updateLizardMetadata,
    
    // Species operations
    getSpeciesCodesForProjectByTaxa,
    
    // Utility functions
    getStandardizedDateTimeString,
    validateSessionData,
    validateEntryData,
    handleFirestoreError
};