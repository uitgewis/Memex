import memdown from 'memdown'
import * as indexedDB from 'fake-indexeddb'
import * as IDBKeyRange from 'fake-indexeddb/lib/FDBKeyRange'
import { handleAttachment as addPouchPageAttachment } from '../../page-storage/store-page'
import * as search from '../'
import * as oldIndex from '../search-index-old'
import * as newIndex from '../search-index-new'
import exportOldPages from '../search-index-old/export'
import importNewPage from '../search-index-new/import'
import * as data from './import-export.test.data'
import { MigrationManager, ExportedPage } from './'

jest.mock('../search-index-new/models/abstract-model')

async function insertTestPageIntoOldIndex() {
    search.getBackend._reset({ useOld: true })

    await search.addPage({
        pageDoc: data.PAGE_DOC_1,
        bookmarkDocs: [],
        visits: [data.TEST_VISIT_1],
    })
    await Promise.all(
        data.EXPORTED_PAGE_1.tags.map(tag =>
            search.addTag(data.PAGE_DOC_1.url, tag),
        ),
    )
    await search.addBookmark({
        url: data.PAGE_DOC_1.url,
        timestamp: data.TEST_BOOKMARK_1,
    })
    await addPouchPageAttachment(
        data.PAGE_DOC_1._id,
        'screenshot',
        data.TEST_SCREENSHOT,
    )
    await addPouchPageAttachment(
        data.PAGE_DOC_1._id,
        'favIcon',
        data.TEST_FAVICON,
    )
}

async function resetDataSources(dbName = 'test') {
    // Don't have any destroy methods available;
    //   => update pointer to memdown and manually delete fake-indexeddb's DB
    indexedDB.deleteDatabase(dbName)
    oldIndex.init({ levelDown: memdown() })
    newIndex.init({ indexedDB, IDBKeyRange, dbName })
}

describe('Old=>New index migration', () => {
    describe('read ops', () => {
        beforeAll(async () => {
            await resetDataSources()
            await insertTestPageIntoOldIndex()
        })

        test('Exporting old-index data', async () => {
            for await (const { pages: [page] } of exportOldPages()) {
                expect(page).toEqual(data.EXPORTED_PAGE_1)
            }
        })
    })

    describe('read-write ops', () => {
        beforeEach(async () => {
            await resetDataSources()
            await insertTestPageIntoOldIndex()
        })

        test('Importing data to new index', async () => {
            search.getBackend._reset({ useOld: false })

            await importNewPage(data.EXPORTED_PAGE_1)

            const { docs: [result] } = await search.search({
                query: 'mining',
                mapResultsFunc: r => r,
            })

            expect(result).toEqual([
                data.PAGE_DOC_1.normalizedUrl,
                data.TEST_BOOKMARK_1,
            ])
        })

        test('Simple full migration', async () => {
            // Set up to do same search, resolving to first result
            const doSearch = () =>
                search
                    .search({
                        query: 'virus',
                        mapResultsFunc: results =>
                            results.map(([id, time, doc]) => [id, time]),
                    })
                    .then(res => res.docs[0])

            search.getBackend._reset({ useOld: true })
            const oldResult = await doSearch()
            expect(oldResult[0]).toEqual(data.PAGE_DOC_1._id)

            // Perform migration then reset the backend to point to new index
            await new MigrationManager().start()
            search.getBackend._reset({ useOld: false })

            // New index should get same doc with updated unencoded URL ID
            const newResultPostMigration = await doSearch()
            expect(newResultPostMigration[0]).toEqual(data.EXPORTED_PAGE_1.url)
        })
    })
})
