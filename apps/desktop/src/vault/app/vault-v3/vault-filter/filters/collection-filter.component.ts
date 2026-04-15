import { Component, input, computed, output } from "@angular/core";

import { TreeNode } from "@bitwarden/common/vault/models/domain/tree-node";
import { NavigationModule, A11yTitleDirective } from "@bitwarden/components";
import { VaultFilter, CollectionFilter } from "@bitwarden/vault";

// FIXME(https://bitwarden.atlassian.net/browse/CL-764): Migrate to OnPush
// eslint-disable-next-line @angular-eslint/prefer-on-push-component-change-detection
@Component({
  selector: "app-collection-filter",
  templateUrl: "collection-filter.component.html",
  imports: [A11yTitleDirective, NavigationModule],
})
export class CollectionFilterComponent {
  protected readonly collection = input.required<TreeNode<CollectionFilter>>();
  protected readonly activeFilter = input<VaultFilter>();
  // AZCO: when true, a pencil edit affordance is rendered next to the
  // collection row and the editCollection output fires on click.
  readonly canEdit = input<boolean>(false);
  readonly editCollection = output<TreeNode<CollectionFilter>>();

  protected readonly displayName = computed<string>(() => {
    return this.collection().node.name;
  });

  protected readonly isActive = computed<boolean>(() => {
    return (
      this.collection().node.id === this.activeFilter()?.collectionId &&
      !!this.activeFilter()?.selectedCollectionNode
    );
  });

  protected applyFilter(event: Event) {
    event.stopPropagation();

    const filter = this.activeFilter();

    if (filter) {
      filter.selectedCollectionNode = this.collection();
    }
  }

  protected onEditClick(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    this.editCollection.emit(this.collection());
  }
}
