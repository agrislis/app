import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useChainId, useSwitchChain, useWalletClient } from 'wagmi'
import { isAddress, type Chain, type Address, encodePacked, toHex } from 'viem'

import {
  isTagListOp,
  listOpAddTag,
  listOpAddListRecord,
  extractAddressAndTag
} from '#/utils/list-ops'
import { Step } from '#/components/checkout/types'
import { DEFAULT_CHAIN } from '#/lib/constants/chain'
import { useEFPProfile } from '#/contexts/efp-profile-context'
import { useCart, type CartItem } from '#/contexts/cart-context'
import { efpListRecordsAbi, efpListRegistryAbi } from '#/lib/abi'
import { generateListStorageLocationSlot } from '#/app/efp/utilities'
import type { FollowingResponse, ProfileDetailsResponse } from '#/types/requests'
import { coreEfpContracts, ListRecordContracts } from '#/lib/constants/contracts'
import { EFPActionType, useActions, type Action } from '#/contexts/actions-context'

type SaveListSettingsParams = {
  selectedList: number
  profile: ProfileDetailsResponse
  chain?: Chain
  newChain?: Chain
  slot?: bigint
  owner?: string
  manager?: string
  user?: string
  listRecordsContractAddress?: Address
  changedValues: {
    chain: boolean
    owner: boolean
    manager: boolean
    user: boolean
  }
  onClose: () => void
  onCancel: () => void
  listState?: FollowingResponse[]
}

const useSaveListSettings = ({
  selectedList,
  profile,
  chain,
  newChain,
  slot,
  owner,
  manager,
  user,
  listRecordsContractAddress,
  changedValues,
  onClose,
  onCancel,
  listState
}: SaveListSettingsParams) => {
  const [currentStep, setCurrentStep] = useState(Step.InitiateTransactions)
  const [completeTransactions, setCompleteTransactions] = useState({
    user: false,
    manager: false,
    owner: false,
    chain: false
  })

  const {
    addActions,
    actions,
    executeActionByIndex,
    resetActions,
    moveToNextAction,
    currentActionIndex
  } = useActions()
  const {
    refetchLists,
    refetchRoles,
    refetchProfile,
    refetchFollowing,
    refetchFollowers,
    setIsRefetchingProfile,
    setIsRefetchingFollowing
  } = useEFPProfile()
  const { resetCart } = useCart()
  const currentChainId = useChainId()
  const { switchChain } = useSwitchChain()
  const { address: userAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const newSlot = useMemo(() => generateListStorageLocationSlot(), [])
  const { t } = useTranslation('profile', { keyPrefix: 'list settings' })

  const setListStorageLocationTx = useCallback(async () => {
    if (!newChain) return

    const listRecordsContractAddress = newChain
      ? (ListRecordContracts[newChain?.id] as Address)
      : coreEfpContracts.EFPListRecords

    const data = encodePacked(
      ['uint8', 'uint8', 'uint256', 'address', 'uint'],
      [1, 1, BigInt(newChain.id), listRecordsContractAddress, newSlot]
    )

    const hash = await walletClient?.writeContract({
      address: coreEfpContracts.EFPListRegistry,
      abi: efpListRegistryAbi,
      functionName: 'setListStorageLocation',
      args: [BigInt(selectedList), data]
    })

    if (hash) {
      setCompleteTransactions(prev => ({
        ...prev,
        chain: true
      }))
    }

    // return transaction hash to enable following transaction status in transaction details component
    return hash
  }, [walletClient, newChain])

  const listOpTx = useCallback(
    async (items: CartItem[]) => {
      const listRecordsContract = newChain
        ? (ListRecordContracts[newChain?.id] as Address)
        : coreEfpContracts.EFPListRecords

      // format list operations
      const operations = items.map(item => {
        // append mandatory types and data
        const types = ['uint8', 'uint8', 'uint8', 'uint8', 'address']
        const data: (string | number)[] = [item.listOp.version, item.listOp.opcode, 1, 1]

        if (item.listOp.opcode > 2 && isTagListOp(item.listOp)) {
          // add 'bytes' type for the tag and address and tag to data
          const addrrAndTag = extractAddressAndTag(item.listOp)
          types.push('bytes')
          data.push(...[addrrAndTag.address, toHex(addrrAndTag.tag)])
        } else {
          // add address to data
          data.push(`0x${item.listOp.data.toString('hex')}`)
        }

        // return encoded data into a single HEX string
        return encodePacked(types, data)
      })

      // initiate  'applyListOps' transaction
      const hash = await walletClient?.writeContract({
        address: listRecordsContract,
        abi: efpListRecordsAbi,
        functionName: 'setMetadataValuesAndApplyListOps',
        // @ts-ignore - diff data type handled
        args: [newSlot, [{ key: 'user', value: userAddress }], operations]
      })

      // return transaction hash to enable following transaction status in transaction details component
      return hash
    },
    [walletClient, selectedList]
  )

  const setOwnerTx = useCallback(async () => {
    if (!(isAddress(owner || '') && userAddress)) return

    // const walletClient = await getWalletClient(config)

    const hash = await walletClient?.writeContract({
      address: coreEfpContracts.EFPListRegistry,
      abi: efpListRegistryAbi,
      functionName: 'transferFrom',
      args: [userAddress, owner as Address, BigInt(selectedList)]
    })

    if (hash) {
      setCompleteTransactions(prev => ({
        ...prev,
        owner: true
      }))
    }

    // return transaction hash to enable following transaction status in transaction details component
    return hash
  }, [owner, walletClient])

  const setManagerTx = useCallback(async () => {
    if (!(listRecordsContractAddress && slot && isAddress(manager || ''))) return

    // const walletClient = await getWalletClient(config)

    // initiate  'applyListOps' transaction
    const hash = await walletClient?.writeContract({
      address: listRecordsContractAddress,
      abi: efpListRecordsAbi,
      functionName: 'setListManager',
      args: [slot, manager as Address]
    })

    if (hash) {
      setCompleteTransactions(prev => ({
        ...prev,
        manager: true
      }))
    }

    // return transaction hash to enable following transaction status in transaction details component
    return hash
  }, [slot, listRecordsContractAddress, manager, walletClient])

  const setUserTx = useCallback(async () => {
    if (!(listRecordsContractAddress && slot && isAddress(user || ''))) return

    // initiate  'setListUser' transaction
    const hash = await walletClient?.writeContract({
      address: listRecordsContractAddress,
      abi: efpListRecordsAbi,
      functionName: 'setListUser',
      args: [slot, user as Address]
    })

    if (hash) {
      setCompleteTransactions(prev => ({
        ...prev,
        user: true
      }))
    }

    // return transaction hash to enable following transaction status in transaction details component
    return hash
  }, [slot, listRecordsContractAddress, user, walletClient])

  const setActions = useCallback(() => {
    if (!chain) return

    // Prepare and set actions when selectedChain is updated and not null
    const setListStorageLocation: Action = {
      id: EFPActionType.SetEFPListStorageLocation, // Unique identifier for the action
      type: EFPActionType.SetEFPListStorageLocation,
      label: t('set location'),
      chainId: DEFAULT_CHAIN.id,
      execute: setListStorageLocationTx,
      isPendingConfirmation: false
    }
    const setListOwner: Action = {
      id: EFPActionType.SetEFPListOwner, // Unique identifier for the action
      type: EFPActionType.SetEFPListOwner,
      label: t('set owner'),
      chainId: DEFAULT_CHAIN.id,
      execute: setOwnerTx,
      isPendingConfirmation: false
    }
    const setListManager: Action = {
      id: EFPActionType.SetEFPListManager, // Unique identifier for the action
      type: EFPActionType.SetEFPListManager,
      label: t('set manager'),
      chainId: chain.id,
      execute: setManagerTx,
      isPendingConfirmation: false
    }
    const setListUser: Action = {
      id: EFPActionType.SetEFPListUser, // Unique identifier for the action
      type: EFPActionType.SetEFPListUser,
      label: t('set user'),
      chainId: chain.id,
      execute: setUserTx,
      isPendingConfirmation: false
    }

    const actionsToExecute: Action[] = []
    if (!completeTransactions.user && changedValues.user) actionsToExecute.push(setListUser)
    if (!completeTransactions.manager && changedValues.manager)
      actionsToExecute.push(setListManager)
    if (changedValues.chain && newChain) {
      if (listState) {
        const listOps = listState.flatMap(item => {
          const operations: CartItem[] = []
          operations.push({ listOp: listOpAddListRecord(item.data) })
          if (item.tags.length > 0)
            item.tags.map(tag => {
              operations.push({ listOp: listOpAddTag(item.data, tag) })
            })
          return operations
        })

        const splitListOps: CartItem[][] = []
        const splitSize = 100

        for (let i = 0; i < listOps.length; i += splitSize) {
          splitListOps.push(listOps.slice(i, i + splitSize))
        }

        const cartItemActions: Action[] = splitListOps.map((listOps, i) => ({
          id: `${EFPActionType.UpdateEFPList} ${i}`, // Unique identifier for the action
          type: EFPActionType.UpdateEFPList,
          label: `Transfer List State ${i + 1}/${splitListOps.length}`,
          chainId: newChain.id,
          execute: async () => await listOpTx(listOps),
          isPendingConfirmation: false
        }))

        if (completeTransactions.chain) actionsToExecute.push(...cartItemActions)
        else actionsToExecute.push(...[setListStorageLocation, ...cartItemActions])
      } else if (!completeTransactions.chain) {
        actionsToExecute.push(setListStorageLocation)
      }
    }
    if (!completeTransactions.owner && changedValues.owner) actionsToExecute.push(setListOwner)

    addActions(actionsToExecute)
  }, [
    listOpTx,
    setListStorageLocationTx,
    setOwnerTx,
    setManagerTx,
    setUserTx,
    changedValues,
    chain
  ])

  useEffect(() => {
    setActions()
  }, [setActions])

  const handleInitiateActions = useCallback(() => {
    if (!chain) return
    if (
      actions[0]?.type === EFPActionType.SetEFPListOwner ||
      actions[0]?.type === EFPActionType.SetEFPListStorageLocation
        ? currentChainId !== DEFAULT_CHAIN.id
        : actions[0]?.type === EFPActionType.UpdateEFPList
          ? newChain?.id !== currentChainId
          : currentChainId !== chain?.id
    ) {
      switchChain({
        chainId:
          actions[0]?.type === EFPActionType.SetEFPListOwner ||
          actions[0]?.type === EFPActionType.SetEFPListStorageLocation
            ? DEFAULT_CHAIN.id
            : actions[0]?.type === EFPActionType.UpdateEFPList && newChain
              ? newChain.id
              : chain.id
      })
      return
    }

    setCurrentStep(Step.TransactionStatus)
    executeActionByIndex(0)
  }, [executeActionByIndex, currentChainId])

  const handleNextAction = useCallback(async () => {
    if (!chain) return
    if (
      actions[currentActionIndex + 1]?.type === EFPActionType.SetEFPListOwner ||
      actions[currentActionIndex + 1]?.type === EFPActionType.SetEFPListStorageLocation
        ? currentChainId !== DEFAULT_CHAIN.id
        : actions[currentActionIndex + 1]?.type === EFPActionType.UpdateEFPList
          ? newChain?.id !== currentChainId
          : currentChainId !== chain?.id
    ) {
      switchChain(
        {
          chainId:
            actions[currentActionIndex + 1]?.type === EFPActionType.SetEFPListOwner ||
            actions[currentActionIndex + 1]?.type === EFPActionType.SetEFPListStorageLocation
              ? DEFAULT_CHAIN.id
              : actions[currentActionIndex + 1]?.type === EFPActionType.UpdateEFPList && newChain
                ? newChain?.id
                : chain.id
        },
        {
          onSettled: () => {
            setCurrentStep(Step.InitiateTransactions)
            // const nextActionIndex = moveToNextAction()
            // executeActionByIndex(nextActionIndex)
          }
        }
      )
      return
    }

    const nextActionIndex = moveToNextAction()
    executeActionByIndex(nextActionIndex)
  }, [moveToNextAction, executeActionByIndex, currentChainId, currentActionIndex])

  const onFinish = useCallback(() => {
    setIsRefetchingProfile(true)
    setIsRefetchingFollowing(true)

    if (changedValues.manager) resetCart()

    // Refetch all related data
    refetchLists()
    refetchRoles()
    refetchProfile()
    refetchFollowing()
    refetchFollowers()

    resetActions()
    onCancel()
    onClose()
  }, [changedValues])

  return {
    actions,
    onFinish,
    currentStep,
    setCurrentStep,
    handleNextAction,
    handleInitiateActions
  }
}

export default useSaveListSettings