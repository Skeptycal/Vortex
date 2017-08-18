import { IGameStored } from '../../extensions/gamemode_management/types/IGameStored';
import {IFilterProps, ITableFilter} from '../../types/ITableAttribute';

import * as React from 'react';
import { connect } from 'react-redux';
import * as Select from 'react-select';
export interface IConnectedProps {
  games: { [gameId: string]: IGameStored};
}

export type IProps = IFilterProps & IConnectedProps;

export class GameFilterComponent extends React.Component<IProps, {}> {
  public render(): JSX.Element {
    const { filter, games } = this.props;

    const game = Object.keys(games)
      .map(gameId => games[gameId].shortName || games[gameId].name);

    const options = game.map(name => ({
      label: name,
      value: name,
    }));

    return (
      <Select
        className='select-compact'
        options={options}
        value={filter}
        onChange={this.changeFilter}
      />
    );
  }

  private changeFilter = (value: { value: string, label: string }) => {
    const { attributeId, onSetFilter } = this.props;
    onSetFilter(attributeId, value !== null ? value.value : null);
  }
}

function mapStateToProps(state: any): IConnectedProps {
  return {
    games: state.session.gameMode.known,
  };
}

const FilterConn = connect(mapStateToProps)(
  GameFilterComponent) as React.ComponentClass<IFilterProps>;

class GameFilter implements ITableFilter {
  public component = FilterConn;
  public raw = false;

  public matches(filter: any, value: any): boolean {
    return filter === value;
  }
}

export default GameFilter;