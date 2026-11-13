import React, { useRef, useImperativeHandle, useCallback, useMemo, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import type { ListRange } from 'react-virtuoso';
import type { ClipboardEntry } from "../../../shared/types";
import type { VirtualClipboardListHandle, VirtualClipboardListProps } from "../types";

type VirtuosoListContext = {
    header?: React.ReactNode;
    hasMore: boolean;
    isLoading: boolean;
    /** False for the first couple of frames after mount: a list that is still
     * measuring its rows would otherwise flash its footer into view. */
    ready: boolean;
};

const ListHeader = ({ context }: { context?: VirtuosoListContext }) => {
    const header = context?.header;
    return header ? <div className="list-header">{header}</div> : null;
};

const ListFooter = ({ context }: { context?: VirtuosoListContext }) => {
    if (!context) return null;
    const { isLoading, hasMore, ready } = context;
    if (!ready) return null;
    if (!isLoading && !hasMore) return null;

    return (
        <div style={{
            padding: '20px',
            textAlign: 'center',
            opacity: 0.6,
            fontSize: '12px',
            color: 'var(--text-secondary)'
        }}>
            {isLoading ? '加载中...' : '加载更多...'}
        </div>
    );
};

const VirtualClipboardList = React.forwardRef<VirtualClipboardListHandle, VirtualClipboardListProps>(
    (props, ref) => {
        const {
            items,
            renderItem,
            onLoadMore,
            hasMore,
            isLoading,
            selectedIndex,
            isKeyboardMode,
            onScroll,
            compactMode,
            header,
            restoreStateFrom,
            onStateChange
        } = props;

        const virtuosoRef = useRef<VirtuosoHandle>(null);
        // A freshly mounted list measures row heights over the next frames; until
        // then the footer sits inside the viewport. Keep it hidden so switching a
        // filter or a layout width never flashes "加载更多…".
        const [footerReady, setFooterReady] = useState(false);
        React.useEffect(() => {
            let second = 0;
            const first = requestAnimationFrame(() => {
                second = requestAnimationFrame(() => setFooterReady(true));
            });
            return () => {
                cancelAnimationFrame(first);
                cancelAnimationFrame(second);
            };
        }, []);
        const visibleRangeRef = useRef<ListRange | null>(null);
        const restoredSelectionRef = useRef(restoreStateFrom ? { index: selectedIndex, keyboard: isKeyboardMode } : null);
        useImperativeHandle(ref, () => ({
            scrollToItem: (index: number) => {
                virtuosoRef.current?.scrollIntoView({
                    index,
                    behavior: 'smooth',
                    align: 'center',
                });
            },
            scrollToTop: () => {
                virtuosoRef.current?.scrollTo({
                    top: 0,
                    behavior: 'auto'
                });
            },
            resetAfterIndex: (_index: number) => {
                // Not needed with Virtuoso as it handles dynamic heights automatically
            }
        }));

        // Keep keyboard selection visible even when the item is only in overscan
        React.useEffect(() => {
            // Returning to the same list must not recenter an unchanged selection.
            const restored = restoredSelectionRef.current;
            if (restored && restored.index === selectedIndex && restored.keyboard === isKeyboardMode) return;
            restoredSelectionRef.current = null;
            if (!isKeyboardMode || selectedIndex < 0) return;

            const range = visibleRangeRef.current;
            const edgeBuffer = 1;

            if (!range) {
                virtuosoRef.current?.scrollToIndex({
                    index: selectedIndex,
                    behavior: 'auto',
                    align: 'center',
                });
                return;
            }

            if (selectedIndex < range.startIndex + edgeBuffer) {
                virtuosoRef.current?.scrollToIndex({
                    index: selectedIndex,
                    behavior: 'auto',
                    align: 'start',
                });
                return;
            }

            if (selectedIndex > range.endIndex - edgeBuffer) {
                virtuosoRef.current?.scrollToIndex({
                    index: selectedIndex,
                    behavior: 'auto',
                    align: 'end',
                });
            }
        }, [selectedIndex, isKeyboardMode]);


        // Handle scroll events
        const handleScroll = useCallback((scrollTop: number) => {
            onScroll?.(scrollTop);
            // Virtuoso's internal scroll state can lag this DOM event by one tick.
            if (onStateChange) virtuosoRef.current?.getState(snapshot => onStateChange({ ...snapshot, scrollTop }));
        }, [onScroll, onStateChange]);

        // Handle end reached for infinite loading
        const handleEndReached = useCallback(() => {
            if (hasMore && !isLoading && onLoadMore) {
                onLoadMore();
            }
        }, [hasMore, isLoading, onLoadMore]);

        const handleRangeChanged = useCallback((range: ListRange) => {
            visibleRangeRef.current = range;
        }, []);

        // Memoized item renderer for Virtuoso
        const itemContent = useCallback((index: number, item: ClipboardEntry) => {
            return (
                <div style={{ paddingBottom: compactMode ? 2 : 4 }}>
                    {renderItem(item, index, index === 0)}
                </div>
            );
        }, [renderItem, compactMode]);

        const components = useMemo(() => ({
            Header: ListHeader,
            Footer: ListFooter
        }), []);

        const context = useMemo(() => ({
            header,
            hasMore,
            isLoading,
            ready: footerReady
        }), [header, hasMore, isLoading, footerReady]);

        return (
            <div className="virtual-list-wrapper" style={{ height: '100%', width: '100%' }}>
                <Virtuoso
                    ref={virtuosoRef}
                    data={items}
                    restoreStateFrom={restoreStateFrom}
                    itemContent={itemContent}
                    components={components}
                    context={context}
                    style={{ height: '100%' }}
                    onScroll={(e) => handleScroll((e.currentTarget as HTMLElement).scrollTop)}
                    endReached={handleEndReached}
                    rangeChanged={handleRangeChanged}
                    overscan={200} // Pre-render 200px of content for smoother scrolling
                />
            </div>
        );
    }
);

VirtualClipboardList.displayName = 'VirtualClipboardList';

export { VirtualClipboardList };
export default VirtualClipboardList;


