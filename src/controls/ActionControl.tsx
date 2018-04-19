import { IActionDefinition, IActionOptions } from '../types/IActionDefinition';
import { extend, IExtensibleProps } from '../util/ExtensionProvider';

import * as React from 'react';

export interface IActionControlProps {
  instanceId?: string | string[];
  filter?: (action: IActionDefinition) => boolean;
}

export interface IExtensionProps {
  objects: IActionDefinition[];
}

type IProps = IActionControlProps & IExtensionProps;

function iconSort(lhs: IActionDefinition, rhs: IActionDefinition): number {
  return (lhs.position || 100) - (rhs.position || 100);
}

export interface IActionDefinitionEx extends IActionDefinition {
  show: boolean | string;
}

/**
 * wrapper control providing an extensible set of icons/buttons/actions
 * In the simplest form this is simply a bunch of buttons that will run
 * an action if clicked, but an icon can also be more dynamic (i.e. rendering
 * dynamic content or having multiple states)
 *
 * @class IconBar
 */
class ActionControl extends React.Component<IProps, {}> {
  public render() {
    const { children, instanceId, objects } = this.props;
    return React.cloneElement(React.Children.only(children), {
      instanceId,
      actions: this.actionsToShow(),
    });
  }

  private iconSort = (lhs: IActionDefinition, rhs: IActionDefinition): number =>
    (lhs.position || 100) - (rhs.position || 100)

  private actionsToShow(): IActionDefinitionEx[] {
    const { filter, instanceId, objects } = this.props;
    const instanceIds = typeof(instanceId) === 'string' ? [instanceId] : instanceId;
    const checkCondition = (def: IActionDefinition): boolean | string => {
      if (def.condition === undefined) {
        return true;
      }
      try {
        return def.condition(instanceIds);
      } catch (err) {
        return `Error: ${err.message}`;
      }
    };

    return objects
      .map((iter): IActionDefinition & { show: boolean | string } => ({
          ...iter,
          show: checkCondition(iter),
        }))
      .filter(iter => iter.show !== false)
      .filter(iter => (filter === undefined) || filter(iter));
  }
}

/**
 * called to register an extension icon. Please note that this function is called once for every
 * icon bar in the ui for each icon. Only the bar with matching group name should accept the icon
 * by returning a descriptor object.
 *
 * @param {IconBar} instance the bar to test against. Please note that this is not actually an
 *                           IconBar instance but the Wrapper, as the bar itself is not yet
 *                           registered, but all props are there
 * @param {string} group name of the icon group this icon wants to be registered with
 * @param {string} icon name of the icon to use
 * @param {string} title title of the icon
 * @param {*} action the action to call on click
 * @returns
 */
function registerAction(instanceGroup: string,
                        group: string,
                        position: number,
                        iconOrComponent: string | React.ComponentClass<any>,
                        options: IActionOptions,
                        titleOrProps?: string | (() => any),
                        actionOrCondition?: (instanceIds?: string[]) => void | boolean,
                        condition?: () => boolean | string,
                        ): any {
  if (instanceGroup === group) {
    if (typeof(iconOrComponent) === 'string') {
      return { type: 'simple', icon: iconOrComponent, title: titleOrProps,
               position, action: actionOrCondition, options, condition };
    } else {
      return { type: 'ext', component: iconOrComponent, props: titleOrProps,
               position, condition: actionOrCondition, options };
    }
  } else {
    return undefined;
  }
}

export default
  extend(registerAction, 'group')(ActionControl) as React.ComponentClass<IActionControlProps>;