import {IExtensionContext} from '../../types/IExtensionContext';
import {IState} from '../../types/IState';
import {log} from '../../util/log';
import { showError } from '../../util/message';
import { activeGameId } from '../../util/selectors';
import { getSafe } from '../../util/storeHelper';

import { setDownloadModInfo } from '../download_management/actions/state';
import { setModAttribute } from '../mod_management/actions/mods';
import { IModWithState } from '../mod_management/types/IModProps';

import { loadCategories, updateCategories } from './actions/category';
import { showCategoriesDialog } from './actions/session';
import {categoryReducer} from './reducers/category';
import { sessionReducer } from './reducers/session';
import { allCategories } from './selectors';
import { ICategoryDictionary, ICategory } from './types/ICategoryDictionary';
import { ICategoriesTree } from './types/ITrees';
import CategoryFilter from './util/CategoryFilter';
import { setCategory } from './actions/category';
import { resolveCategoryName, resolveCategoryPath } from './util/retrieveCategoryPath';
import CategoryDialog from './views/CategoryDialog';

import * as Redux from 'redux';

export const UNASSIGNED = 'Unassigned';

// export for api
export { resolveCategoryName, resolveCategoryPath };

function getModCategory(mod: IModWithState) {
  return getSafe(mod, ['attributes', 'category'], undefined);
}

function getUnassignedCategory(store: Redux.Store<any>, gameMode: string): ICategory {
  const state: IState = store.getState();
  const catDictionary: ICategoryDictionary = getSafe(state, ['persistent', 'categories', gameMode], {});
  let unassignedCat: ICategory = Object.keys(catDictionary).map(key => catDictionary[key]).find(category => category.name === UNASSIGNED);
  if (unassignedCat === undefined) {
    const catsMap = Object.keys(catDictionary).map(key => catDictionary[key]);
    const minOrder: number = catsMap.reduce((min, cat) => cat.order < min ? cat.order : min, catsMap[0].order);
    unassignedCat = createUnassignedCategory(store, gameMode, minOrder - 1);
  }
  return unassignedCat;
}

function createUnassignedCategory(store: Redux.Store<any>, gameMode: string, loadOrder: number): ICategory {
  const unassignedCat = { name: UNASSIGNED, order: loadOrder, parentCategory: undefined };
  store.dispatch(setCategory(gameMode, UNASSIGNED, unassignedCat))

  return unassignedCat;
}

function getCategoryChoices(state: IState) {
  const categories: ICategoryDictionary = allCategories(state);

  return [ {key: '', text: ''} ].concat(
    Object.keys(categories)
      .map(id => ({ key: id, text: resolveCategoryPath(id, state) }))
      .sort((lhs, rhs) => categories[lhs.key].order - categories[rhs.key].order));
}

function init(context: IExtensionContext): boolean {
  context.registerDialog('categories', CategoryDialog);
  context.registerAction('mod-icons', 100, 'categories', {}, 'Categories', () => {
    context.api.store.dispatch(showCategoriesDialog(true));
  });

  context.registerReducer(['persistent', 'categories'], categoryReducer);
  context.registerReducer(['session', 'categories'], sessionReducer);

  context.registerTableAttribute('mods', {
    id: 'category',
    name: 'Category',
    description: 'Mod Category',
    icon: 'sitemap',
    placement: 'table',
    calc: (mod: IModWithState) => {
      let category = getModCategory(mod);
      if (category === undefined) {
        const gameMode = activeGameId(context.api.store.getState());
        const unassigned: ICategory = getUnassignedCategory(context.api.store, gameMode);
        (mod.state === 'downloaded') 
          ? context.api.store.dispatch(
              setDownloadModInfo(mod.id, 'nexus.modInfo.category_id', unassigned.name))
          : context.api.store.dispatch(
              setModAttribute(gameMode, mod.id, 'category', unassigned.name));

        category = unassigned.name;
      }

      return resolveCategoryName(category, context.api.store.getState());
    },
    isToggleable: true,
    edit: {},
    isSortable: true,
    filter: new CategoryFilter(),
  });

  context.registerTableAttribute('mods', {
    id: 'category-detail',
    name: 'Category',
    description: 'Mod Category',
    icon: 'sitemap',
    supportsMultiple: true,
    calc: (mod: IModWithState) =>
      resolveCategoryPath(getModCategory(mod), context.api.store.getState()),
    edit: {
      choices: () => getCategoryChoices(context.api.store.getState()),
      onChangeValue: (rows: IModWithState[], newValue: any) => {
        const gameMode = activeGameId(context.api.store.getState());
        rows.forEach(row => {
          if (row.state === 'downloaded') {
            context.api.store.dispatch(
              setDownloadModInfo(row.id, 'custom.category', newValue));
          } else {
            context.api.store.dispatch(
                setModAttribute(gameMode, row.id, 'category', newValue));
          }
        });
      },
    },
    placement: 'detail',
    isToggleable: false,
    isSortable: true,
  });

  context.once(() => {
    const store: Redux.Store<any> = context.api.store;

    try {
      context.api.events.on('update-categories', (gameId, categories, isUpdate) => {
        if (isUpdate) {
          context.api.store.dispatch(updateCategories(gameId, categories));
        } else {
          context.api.store.dispatch(loadCategories(gameId, categories));
        }
      });

      context.api.events.on('gamemode-activated', (gameMode: string) => {
        const categories: ICategoriesTree[] = getSafe(store.getState(),
          ['persistent', 'categories', gameMode], undefined);
        const APIKEY = getSafe(store.getState(),
          ['confidential', 'account', 'nexus', 'APIKey'], undefined);
        if (categories === undefined && APIKEY !== undefined) {
          context.api.events.emit('retrieve-category-list', false, {});
        } else if (categories !== undefined && categories.length === 0) {
          context.api.store.dispatch(updateCategories(gameMode, {}));
        }
      });
    } catch (err) {
      log('error', 'Failed to load categories', err);
      showError(store.dispatch, 'Failed to load categories', err);
    }
  });

  return true;
}

export default init;
